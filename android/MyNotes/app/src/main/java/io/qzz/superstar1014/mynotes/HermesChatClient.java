package io.qzz.superstar1014.mynotes;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

final class HermesChatClient {
  static final String RELAY_URL = "wss://h.superstar1014.qzz.io/api/hermes-chat/ws";

  interface Listener {
    void onReady();
    void onMessage(HermesChatCrypto.ChatMessage message);
    void onAcknowledged(String messageId, long sequence);
    void onTyping(boolean active);
    void onDisconnected(String reason);
  }

  private final HermesChatCrypto crypto;
  private final Listener listener;
  private final OkHttpClient http;
  private WebSocket socket;
  private boolean closing;
  private long lastSequence;

  HermesChatClient(HermesChatCrypto crypto, Listener listener) {
    this.crypto = crypto;
    this.listener = listener;
    http = new OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build();
  }

  void connect(Models.HermesChatTicket ticket) {
    close();
    closing = false;
    Request request = new Request.Builder()
      .url(RELAY_URL)
      .header("Authorization", "Bearer " + ticket.ticket)
      .header("X-Hermes-Role", "client")
      .header("X-Hermes-Space", ticket.spaceId)
      .build();
    socket = http.newWebSocket(request, new SocketListener());
  }

  HermesChatCrypto.ChatMessage sendMessage(String text, JSONArray attachments) throws Exception {
    String id = UUID.randomUUID().toString();
    long sentAt = System.currentTimeMillis();
    JSONObject envelope = crypto.encryptMessage("client", text, attachments, id, sentAt);
    if (!send(envelope)) throw new IllegalStateException("聊天连接尚未就绪。");
    return new HermesChatCrypto.ChatMessage(
      id,
      "client",
      sentAt,
      0,
      text == null ? "" : text,
      attachments == null ? new JSONArray() : attachments
    );
  }

  void sendTyping(boolean active) {
    try {
      send(new JSONObject()
        .put("v", 1)
        .put("type", "typing")
        .put("active", active));
    } catch (Exception ignored) {
      // Typing state is ephemeral and must not interrupt message entry.
    }
  }

  boolean isConnected() {
    return socket != null && !closing;
  }

  void close() {
    closing = true;
    WebSocket current = socket;
    socket = null;
    if (current != null) current.close(1000, "Android chat closed");
  }

  void shutdown() {
    close();
    http.dispatcher().executorService().shutdown();
    http.connectionPool().evictAll();
  }

  private boolean send(JSONObject frame) {
    WebSocket current = socket;
    return current != null && current.send(frame.toString());
  }

  private final class SocketListener extends WebSocketListener {
    @Override
    public void onOpen(WebSocket webSocket, Response response) {
      socket = webSocket;
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
      if (webSocket != socket) return;
      try {
        JSONObject frame = new JSONObject(text);
        String type = frame.optString("type");
        if ("ready".equals(type)) {
          send(new JSONObject()
            .put("v", 1)
            .put("type", "resume")
            .put("afterSeq", lastSequence));
          listener.onReady();
          return;
        }
        if ("message".equals(type)) {
          long sequence = frame.optLong("seq");
          HermesChatCrypto.ChatMessage message = crypto.decryptMessage(
            frame.getJSONObject("message"),
            sequence
          );
          lastSequence = Math.max(lastSequence, sequence);
          listener.onMessage(message);
          return;
        }
        if ("resume_complete".equals(type)) {
          if (frame.optBoolean("hasMore")) {
            send(new JSONObject()
              .put("v", 1)
              .put("type", "resume")
              .put("afterSeq", lastSequence));
          }
          return;
        }
        if ("ack".equals(type)) {
          listener.onAcknowledged(frame.optString("id"), frame.optLong("seq"));
          return;
        }
        if ("typing".equals(type) && "agent".equals(frame.optString("sender"))) {
          listener.onTyping(frame.optBoolean("active"));
          return;
        }
        if ("error".equals(type)) {
          listener.onDisconnected(frame.optString("message", "Cloudflare 拒绝了聊天消息。"));
        }
      } catch (Exception error) {
        listener.onDisconnected("无法解析加密聊天消息：" + error.getMessage());
      }
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
      webSocket.close(code, reason);
    }

    @Override
    public void onClosed(WebSocket webSocket, int code, String reason) {
      if (webSocket != socket) return;
      socket = null;
      if (!closing) listener.onDisconnected(reason.isEmpty() ? "聊天连接已断开。" : reason);
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable error, Response response) {
      if (webSocket != socket) return;
      socket = null;
      if (!closing) {
        String message = error.getMessage();
        listener.onDisconnected(message == null ? "无法连接 Hermes。" : message);
      }
    }
  }
}
