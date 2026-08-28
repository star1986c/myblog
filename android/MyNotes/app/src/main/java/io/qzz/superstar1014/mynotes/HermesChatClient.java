package io.qzz.superstar1014.mynotes;

import android.os.Handler;
import android.os.Looper;

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
  private static final long HANDSHAKE_TIMEOUT_MS = 20_000L;

  interface Listener {
    void onReady();
    void onMessage(
      String spaceId,
      HermesChatCrypto.ChatMessage message,
      String sessionToken
    );
    void onAcknowledged(
      String spaceId,
      String messageId,
      long sequence,
      String sessionToken
    );
    void onActionAcknowledged(
      String spaceId,
      String actionId,
      boolean delivered,
      String sessionToken
    );
    void onTyping(
      String spaceId,
      boolean active,
      boolean terminal,
      String sessionToken
    );
    void onProfileError(String spaceId, String reason, String sessionToken);
    void onDisconnected(String reason);
  }

  private final Listener listener;
  private final OkHttpClient http;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Object socketStateLock = new Object();
  private final Object profileStateLock = new Object();
  private final Map<String, ProfileState> profiles = new ConcurrentHashMap<>();
  private volatile WebSocket socket;
  private volatile boolean closing;
  private Runnable handshakeTimeoutTask;
  private boolean handshakePending;

  HermesChatClient(Listener listener) {
    this.listener = listener;
    http = new OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .pingInterval(25, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build();
  }

  void configureProfile(
    String spaceId,
    HermesChatCrypto crypto,
    String keyFingerprint,
    long initialSequence
  ) {
    if (initialSequence < 0) throw new IllegalArgumentException("聊天恢复序号无效。");
    synchronized (profileStateLock) {
      profiles.put(spaceId, new ProfileState(crypto, keyFingerprint, initialSequence));
    }
  }

  void retainProfiles(Set<String> spaceIds) {
    synchronized (profileStateLock) {
      profiles.keySet().removeIf(spaceId -> !spaceIds.contains(spaceId));
    }
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
    Map<String, String> sessionTokens = new ConcurrentHashMap<>();
    synchronized (profileStateLock) {
      for (String spaceId : ticket.spaceIds) {
        ProfileState profile = profiles.get(spaceId);
        if (profile != null) sessionTokens.put(spaceId, profile.keyFingerprint);
      }
    }
    WebSocket nextSocket = http.newWebSocket(
      request,
      new SocketListener(List.copyOf(ticket.spaceIds), Map.copyOf(sessionTokens))
    );
    synchronized (socketStateLock) {
      socket = nextSocket;
      scheduleHandshakeTimeoutLocked(nextSocket);
    }
  }

  HermesChatCrypto.ChatMessage sendMessage(
    String spaceId,
    String text,
    JSONArray attachments,
    String expectedSessionToken
  ) throws Exception {
    synchronized (profileStateLock) {
      ProfileState profile = requireProfile(spaceId);
      if (expectedSessionToken != null
          && !profile.keyFingerprint.equals(expectedSessionToken)) {
        throw new IllegalStateException("Hermes 聊天密钥已更改，请重新发送附件。");
      }
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
  }

  String sendInteractionAction(
    String spaceId,
    String promptId,
    String optionId,
    String actionId
  ) throws Exception {
    synchronized (profileStateLock) {
      ProfileState profile = requireProfile(spaceId);
      JSONObject message = profile.crypto.encryptInteractionResponse(
        promptId,
        optionId,
        actionId,
        System.currentTimeMillis()
      );
      JSONObject frame = new JSONObject()
        .put("v", 1)
        .put("type", "action")
        .put("message", message);
      if (!send(spaceId, frame)) throw new IllegalStateException("聊天连接尚未就绪。");
      return actionId;
    }
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
    WebSocket current;
    synchronized (socketStateLock) {
      cancelHandshakeTimeoutLocked();
      current = socket;
      socket = null;
    }
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

  private void scheduleHandshakeTimeoutLocked(WebSocket expectedSocket) {
    cancelHandshakeTimeoutLocked();
    handshakePending = true;
    handshakeTimeoutTask = () -> failHandshakeIfPending(expectedSocket);
    handler.postDelayed(handshakeTimeoutTask, HANDSHAKE_TIMEOUT_MS);
  }

  private boolean cancelHandshakeTimeout(WebSocket expectedSocket) {
    synchronized (socketStateLock) {
      if (socket != expectedSocket || closing || !handshakePending) return false;
      cancelHandshakeTimeoutLocked();
      return true;
    }
  }

  private void cancelHandshakeTimeoutLocked() {
    handshakePending = false;
    if (handshakeTimeoutTask == null) return;
    handler.removeCallbacks(handshakeTimeoutTask);
    handshakeTimeoutTask = null;
  }

  private void failHandshakeIfPending(WebSocket expectedSocket) {
    synchronized (socketStateLock) {
      if (socket != expectedSocket || closing || !handshakePending) return;
      handshakePending = false;
      handshakeTimeoutTask = null;
      socket = null;
    }
    for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
    expectedSocket.cancel();
    listener.onDisconnected("WebSocket 握手超时，正在自动重试。");
  }

  private final class SocketListener extends WebSocketListener {
    private final List<String> ticketSpaces;
    private final Map<String, String> sessionTokens;

    SocketListener(List<String> ticketSpaces, Map<String, String> sessionTokens) {
      this.ticketSpaces = ticketSpaces;
      this.sessionTokens = sessionTokens;
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
      String sessionToken = "";
      try {
        JSONObject frame = new JSONObject(text);
        String type = frame.optString("type");
        if ("ready".equals(type)) {
          if (!frame.optBoolean("multiplex")) {
            throw new IllegalArgumentException("服务器未启用多会话连接。");
          }
          if (!cancelHandshakeTimeout(webSocket)) return;
          for (String ticketSpace : ticketSpaces) sendResume(ticketSpace);
          listener.onReady();
          return;
        }
        if ("pong".equals(type)) return;
        spaceId = frame.getString("spaceId");
        sessionToken = sessionTokens.get(spaceId);
        if (sessionToken == null) return;
        ProfileState profile = requireProfile(spaceId);
        if (!profile.keyFingerprint.equals(sessionToken)) return;
        if ("message".equals(type)) {
          long sequence = frame.optLong("seq");
          HermesChatCrypto.ChatMessage message = profile.crypto.decryptMessage(
            frame.getJSONObject("message"),
            sequence
          );
          profile.lastSequence = Math.max(profile.lastSequence, sequence);
          listener.onMessage(spaceId, message, sessionToken);
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
          listener.onMessage(spaceId, message, sessionToken);
          return;
        }
        if ("resume_complete".equals(type)) {
          if (frame.optBoolean("hasMore")) sendResume(spaceId);
          return;
        }
        if ("ack".equals(type)) {
          if (!frame.optBoolean("durable", true)) {
            listener.onActionAcknowledged(
              spaceId,
              frame.optString("id"),
              frame.optBoolean("delivered"),
              sessionToken
            );
            return;
          }
          long sequence = frame.optLong("seq");
          if (sequence > 0) profile.lastSequence = Math.max(profile.lastSequence, sequence);
          listener.onAcknowledged(
            spaceId,
            frame.optString("id"),
            sequence,
            sessionToken
          );
          return;
        }
        if ("typing".equals(type) && "agent".equals(frame.optString("sender"))) {
          boolean active = frame.optBoolean("active");
          boolean terminal = !active
            && (!frame.has("terminal") || frame.optBoolean("terminal"));
          listener.onTyping(spaceId, active, terminal, sessionToken);
          return;
        }
        if ("error".equals(type)) {
          listener.onProfileError(
            spaceId,
            frame.optString("message", "Cloudflare 拒绝了聊天消息。"),
            sessionToken
          );
        }
      } catch (Exception error) {
        String reason = "无法解析加密聊天消息：" + error.getMessage();
        if (spaceId.isEmpty()) listener.onDisconnected(reason);
        else listener.onProfileError(spaceId, reason, sessionToken);
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
      synchronized (socketStateLock) {
        if (webSocket != socket) return;
        cancelHandshakeTimeoutLocked();
        socket = null;
      }
      for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
      if (!closing) listener.onDisconnected(reason.isEmpty() ? "聊天连接已断开。" : reason);
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable error, Response response) {
      synchronized (socketStateLock) {
        if (webSocket != socket) return;
        cancelHandshakeTimeoutLocked();
        socket = null;
      }
      for (ProfileState profile : profiles.values()) profile.lastTypingActive = null;
      if (!closing) {
        String message = error.getMessage();
        listener.onDisconnected(message == null ? "无法连接 Hermes。" : message);
      }
    }
  }

  private static final class ProfileState {
    final HermesChatCrypto crypto;
    final String keyFingerprint;
    volatile long lastSequence;
    volatile Boolean lastTypingActive;

    ProfileState(
      HermesChatCrypto crypto,
      String keyFingerprint,
      long initialSequence
    ) {
      this.crypto = crypto;
      this.keyFingerprint = keyFingerprint;
      this.lastSequence = initialSequence;
    }
  }
}
