package io.qzz.superstar1014.mynotes;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** One process-wide WebSocket that multiplexes all configured Hermes profiles by spaceId. */
final class HermesChatClient {
  static final String RELAY_URL = "wss://h.superstar1014.qzz.io/api/hermes-chat/ws";

  interface Listener {
    void onReady();
    void onMessage(String spaceId, HermesChatCrypto.ChatMessage message);
    void onAcknowledged(String spaceId, String messageId, long sequence);
    void onTyping(String spaceId, boolean active);
    void onProfileError(String spaceId, String reason);
    void onDisconnected(String reason);
  }

  private final Listener listener;
  private final OkHttpClient http;
  private final Map<String, ProfileState> profiles = new ConcurrentHashMap<>();
  private volatile WebSocket socket;
  private volatile boolean closing;

  HermesChatClient(Listener listener) {
    this.listener = listener;
    http = new OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .pingInterval(25, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build();
  }

  void configureProfile(String spaceId, HermesChatCrypto crypto, long initialSequence) {
    if (initialSequence < 0) throw new IllegalArgumentException("聊天恢复序号无效。");
    profiles.put(spaceId, new ProfileState(crypto, initialSequence));
  }

  void retainProfiles(Set<String> spaceIds) {
    profiles.keySet().removeIf(spaceId -> !spaceIds.contains(spaceId));
  }

  void connect(Models.HermesChatMultiplexTicket ticket) {
    close();
    closing = false;
    Request request = new Request.Builder()
      .url(RELAY_URL)
      .header("Authorization", "Bearer " + ticket.ticket)
      .header("X-Hermes-Role", "client")
      .header("X-Hermes-Mode", "multiplex")
      .build();
    socket = http.newWebSocket(request, new SocketListener(List.copyOf(ticket.spaceIds)));
  }

  HermesChatCrypto.ChatMessage sendMessage(
    String spaceId,
    String text,
    JSONArray attachments
  ) throws Exception {
    ProfileState profile = requireProfile(spaceId);
    String id = UUID.randomUUID().toString();
    long sentAt = System.currentTimeMillis();
    JSONObject envelope = profile.crypto.encryptMessage(
      "client",
      text,
      attachments,
      id,
      sentAt
    );
    if (!send(spaceId, envelope)) throw new IllegalStateException("聊天连接尚未就绪。");
    return new HermesChatCrypto.ChatMessage(
      id,
      "client",
      sentAt,
      0,
      text == null ? "" : text,
      attachments == null ? new JSONArray() : attachments
    );
  }

  void sendTyping(String spaceId, boolean active) {
    ProfileState profile = profiles.get(spaceId);
    if (profile == null || (profile.lastTypingActive != null
        && profile.lastTypingActive == active)) return;
    try {
      boolean sent = send(spaceId, new JSONObject()
        .put("v", 1)
        .put("type", "typing")
        .put("active", active));
      if (sent) profile.lastTypingActive = active;
    } catch (Exception ignored) {
      // Typing state is ephemeral and must not interrupt message entry.
    }
  }

  boolean isConnected() {
    return socket != null && !closing;
  }

  void close() {
    closing = true;
    for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
    WebSocket current = socket;
    socket = null;
    if (current != null) current.close(1000, "Android chat closed");
  }

  void shutdown() {
    close();
    http.dispatcher().executorService().shutdown();
    http.connectionPool().evictAll();
  }

  private ProfileState requireProfile(String spaceId) {
    ProfileState profile = profiles.get(spaceId);
    if (profile == null) throw new IllegalStateException("该 Hermes profile 尚未配置聊天密钥。");
    return profile;
  }

  private boolean send(String spaceId, JSONObject frame) throws Exception {
    WebSocket current = socket;
    if (current == null) return false;
    frame.put("spaceId", spaceId);
    return current.send(frame.toString());
  }

  private final class SocketListener extends WebSocketListener {
    private final List<String> ticketSpaces;

    SocketListener(List<String> ticketSpaces) {
      this.ticketSpaces = ticketSpaces;
    }

    @Override
    public void onOpen(WebSocket webSocket, Response response) {
      if (webSocket != socket) {
        webSocket.close(1000, "Replaced by a newer chat connection");
        return;
      }
      for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
      if (webSocket != socket) return;
      String spaceId = "";
      try {
        JSONObject frame = new JSONObject(text);
        String type = frame.optString("type");
        if ("ready".equals(type)) {
          if (!frame.optBoolean("multiplex")) {
            throw new IllegalArgumentException("服务器未启用多会话连接。");
          }
          for (String ticketSpace : ticketSpaces) sendResume(ticketSpace);
          listener.onReady();
          return;
        }
        if ("pong".equals(type)) return;
        spaceId = frame.getString("spaceId");
        ProfileState profile = requireProfile(spaceId);
        if ("message".equals(type)) {
          long sequence = frame.optLong("seq");
          HermesChatCrypto.ChatMessage message = profile.crypto.decryptMessage(
            frame.getJSONObject("message"),
            sequence
          );
          profile.lastSequence = Math.max(profile.lastSequence, sequence);
          listener.onMessage(spaceId, message);
          return;
        }
        if ("edit".equals(type)) {
          long sequence = frame.optLong("seq");
          HermesChatCrypto.ChatMessage message = profile.crypto.decryptMessage(
            frame.getJSONObject("message"),
            sequence
          );
          if (message.replaceSequence != frame.getLong("targetSeq")
              || message.finalUpdate != frame.getBoolean("final")) {
            throw new IllegalArgumentException("流式消息替换元数据校验失败。");
          }
          if (sequence > 0) profile.lastSequence = Math.max(profile.lastSequence, sequence);
          listener.onMessage(spaceId, message);
          return;
        }
        if ("resume_complete".equals(type)) {
          if (frame.optBoolean("hasMore")) sendResume(spaceId);
          return;
        }
        if ("ack".equals(type)) {
          long sequence = frame.optLong("seq");
          if (sequence > 0) profile.lastSequence = Math.max(profile.lastSequence, sequence);
          listener.onAcknowledged(spaceId, frame.optString("id"), sequence);
          return;
        }
        if ("typing".equals(type) && "agent".equals(frame.optString("sender"))) {
          listener.onTyping(spaceId, frame.optBoolean("active"));
          return;
        }
        if ("error".equals(type)) {
          listener.onProfileError(
            spaceId,
            frame.optString("message", "Cloudflare 拒绝了聊天消息。")
          );
        }
      } catch (Exception error) {
        String reason = "无法解析加密聊天消息：" + error.getMessage();
        if (spaceId.isEmpty()) listener.onDisconnected(reason);
        else listener.onProfileError(spaceId, reason);
      }
    }

    private void sendResume(String spaceId) throws Exception {
      ProfileState profile = requireProfile(spaceId);
      send(spaceId, new JSONObject()
        .put("v", 1)
        .put("type", "resume")
        .put("afterSeq", profile.lastSequence));
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
      webSocket.close(code, reason);
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
      if (webSocket != socket) return;
      socket = null;
      for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
      if (!closing) listener.onDisconnected(reason.isEmpty() ? "聊天连接已断开。" : reason);
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable error, Response response) {
      if (webSocket != socket) return;
      socket = null;
      for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
      if (!closing) {
        String message = error.getMessage();
        listener.onDisconnected(message == null ? "无法连接 Hermes。" : message);
      }
    }
  }

  private static final class ProfileState {
    final HermesChatCrypto crypto;
    volatile long lastSequence;
    volatile Boolean lastTypingActive;

    ProfileState(HermesChatCrypto crypto, long initialSequence) {
      this.crypto = crypto;
      this.lastSequence = initialSequence;
    }
  }
}
