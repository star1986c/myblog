package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Keeps the most recently used profile connected for the lifetime of this app process. */
final class HermesChatConnectionManager {
  interface Listener {
    void onConnecting();
    void onReady();
    void onMessage(HermesChatCrypto.ChatMessage message);
    void onAcknowledged(String messageId, long sequence);
    void onTyping(boolean active);
    void onDisconnected(String reason);
  }

  private enum State {
    IDLE,
    CONNECTING,
    READY,
    DISCONNECTED
  }

  private static final int MAX_PENDING_EVENTS = 500;
  private static final long AWAITING_RESPONSE_TIMEOUT_MS = 120_000L;
  private static volatile HermesChatConnectionManager instance;

  static HermesChatConnectionManager get(Context context) {
    HermesChatConnectionManager current = instance;
    if (current != null) return current;
    synchronized (HermesChatConnectionManager.class) {
      current = instance;
      if (current == null) {
        current = new HermesChatConnectionManager(context.getApplicationContext());
        instance = current;
      }
    }
    return current;
  }

  private final NotesApiClient api;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final ArrayDeque<HermesChatCrypto.ChatMessage> pendingMessages = new ArrayDeque<>();
  private final ArrayDeque<Acknowledgement> pendingAcknowledgements = new ArrayDeque<>();

  private HermesChatClient client;
  private Listener listener;
  private State state = State.IDLE;
  private String profileId = "";
  private String keyFingerprint = "";
  private String disconnectReason = "聊天连接已断开。";
  private long profileGeneration;
  private long connectionAttempt;
  private int reconnectAttempt;
  private boolean awaitingAgentResponse;
  private Runnable reconnectTask;

  private final Runnable expireAwaitingAgentResponse = () -> awaitingAgentResponse = false;

  private HermesChatConnectionManager(Context applicationContext) {
    api = new NotesApiClient(applicationContext);
  }

  void attach(
    String requestedProfileId,
    String encodedKey,
    long initialSequence,
    Listener requestedListener
  ) throws Exception {
    if (requestedListener == null) throw new IllegalArgumentException("聊天监听器不能为空。");
    String requestedFingerprint = fingerprint(encodedKey);
    boolean sameSession = requestedProfileId.equals(profileId)
      && requestedFingerprint.equals(keyFingerprint)
      && client != null;
    listener = requestedListener;
    if (sameSession) {
      publishState(requestedListener);
      drainPendingEvents(requestedListener);
      if (awaitingAgentResponse) requestedListener.onTyping(true);
      if (state == State.DISCONNECTED || state == State.IDLE) reconnect();
      return;
    }

    resetSession();
    profileId = requestedProfileId;
    keyFingerprint = requestedFingerprint;
    long generation = ++profileGeneration;
    client = new HermesChatClient(
      new HermesChatCrypto(encodedKey),
      scopedClientListener(generation),
      initialSequence
    );
    authenticateAndConnect(generation);
  }

  void detach(Listener candidate) {
    if (listener == candidate) listener = null;
  }

  void closeUnless(String requestedProfileId) {
    if (!profileId.isEmpty() && !profileId.equals(requestedProfileId)) resetSession();
  }

  void reconnect() {
    if (client == null || profileId.isEmpty()) return;
    cancelReconnect();
    authenticateAndConnect(profileGeneration);
  }

  void shutdown() {
    listener = null;
    resetSession();
  }

  boolean isReady() {
    return state == State.READY && client != null && client.isConnected();
  }

  boolean isCurrentProfile(String requestedProfileId) {
    return requestedProfileId != null && requestedProfileId.equals(profileId);
  }

  HermesChatCrypto.ChatMessage sendMessage(String text, JSONArray attachments) throws Exception {
    if (!isReady()) throw new IllegalStateException("聊天连接尚未就绪。");
    HermesChatCrypto.ChatMessage message = client.sendMessage(text, attachments);
    markAwaitingAgentResponse();
    return message;
  }

  void sendTyping(boolean active) {
    if (isReady()) client.sendTyping(active);
  }

  private void authenticateAndConnect(long generation) {
    if (generation != profileGeneration || client == null || profileId.isEmpty()) return;
    cancelReconnect();
    state = State.CONNECTING;
    publishState(listener);
    long attempt = ++connectionAttempt;
    String targetProfileId = profileId;
    HermesChatClient targetClient = client;
    executor.submit(() -> {
      try {
        NotesApiClient.SessionResult session = api.restoreSession();
        if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。");
        Models.HermesChatTicket ticket = api.hermesChatTicket(targetProfileId);
        handler.post(() -> {
          if (!matches(generation, attempt, targetProfileId, targetClient)) return;
          targetClient.connect(ticket);
        });
      } catch (Exception error) {
        handler.post(() -> {
          if (!matches(generation, attempt, targetProfileId, targetClient)) return;
          handleDisconnected(generation, message(error));
        });
      }
    });
  }

  private HermesChatClient.Listener scopedClientListener(long generation) {
    return new HermesChatClient.Listener() {
      @Override public void onReady() {
        handler.post(() -> handleReady(generation));
      }

      @Override public void onMessage(HermesChatCrypto.ChatMessage message) {
        handler.post(() -> handleMessage(generation, message));
      }

      @Override public void onAcknowledged(String messageId, long sequence) {
        handler.post(() -> handleAcknowledged(generation, messageId, sequence));
      }

      @Override public void onTyping(boolean active) {
        handler.post(() -> handleTyping(generation, active));
      }

      @Override public void onDisconnected(String reason) {
        handler.post(() -> handleDisconnected(generation, reason));
      }
    };
  }

  private void handleReady(long generation) {
    if (generation != profileGeneration || client == null) return;
    state = State.READY;
    reconnectAttempt = 0;
    publishState(listener);
    if (listener != null) {
      drainPendingEvents(listener);
      if (awaitingAgentResponse) listener.onTyping(true);
    }
  }

  private void handleMessage(long generation, HermesChatCrypto.ChatMessage message) {
    if (generation != profileGeneration || client == null) return;
    if ("agent".equals(message.sender)) clearAwaitingAgentResponse();
    Listener current = listener;
    if (current != null) current.onMessage(message);
    else appendBounded(pendingMessages, message);
  }

  private void handleAcknowledged(long generation, String messageId, long sequence) {
    if (generation != profileGeneration || client == null) return;
    Listener current = listener;
    if (current != null) current.onAcknowledged(messageId, sequence);
    else appendBounded(pendingAcknowledgements, new Acknowledgement(messageId, sequence));
  }

  private void handleTyping(long generation, boolean active) {
    if (generation != profileGeneration || client == null || !active) return;
    markAwaitingAgentResponse();
    Listener current = listener;
    if (current != null) current.onTyping(true);
  }

  private void handleDisconnected(long generation, String reason) {
    if (generation != profileGeneration || client == null) return;
    if (state == State.DISCONNECTED && reconnectTask != null) return;
    state = State.DISCONNECTED;
    disconnectReason = reason == null || reason.trim().isEmpty()
      ? "聊天连接已断开。"
      : reason;
    publishState(listener);
    long delay = Math.min(30_000L, 2_000L << Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    reconnectTask = () -> {
      reconnectTask = null;
      if (generation == profileGeneration && client != null) {
        authenticateAndConnect(generation);
      }
    };
    handler.postDelayed(reconnectTask, delay);
  }

  private void publishState(Listener target) {
    if (target == null) return;
    if (state == State.READY) target.onReady();
    else if (state == State.CONNECTING) target.onConnecting();
    else if (state == State.DISCONNECTED) target.onDisconnected(disconnectReason);
  }

  private void drainPendingEvents(Listener target) {
    while (!pendingAcknowledgements.isEmpty()) {
      Acknowledgement acknowledgement = pendingAcknowledgements.removeFirst();
      target.onAcknowledged(acknowledgement.messageId, acknowledgement.sequence);
    }
    while (!pendingMessages.isEmpty()) target.onMessage(pendingMessages.removeFirst());
  }

  private void markAwaitingAgentResponse() {
    awaitingAgentResponse = true;
    handler.removeCallbacks(expireAwaitingAgentResponse);
    handler.postDelayed(expireAwaitingAgentResponse, AWAITING_RESPONSE_TIMEOUT_MS);
  }

  private void clearAwaitingAgentResponse() {
    awaitingAgentResponse = false;
    handler.removeCallbacks(expireAwaitingAgentResponse);
  }

  private void resetSession() {
    cancelReconnect();
    handler.removeCallbacks(expireAwaitingAgentResponse);
    profileGeneration += 1;
    connectionAttempt += 1;
    if (client != null) client.shutdown();
    client = null;
    state = State.IDLE;
    profileId = "";
    keyFingerprint = "";
    disconnectReason = "聊天连接已断开。";
    reconnectAttempt = 0;
    awaitingAgentResponse = false;
    pendingMessages.clear();
    pendingAcknowledgements.clear();
  }

  private void cancelReconnect() {
    if (reconnectTask == null) return;
    handler.removeCallbacks(reconnectTask);
    reconnectTask = null;
  }

  private boolean matches(
    long generation,
    long attempt,
    String requestedProfileId,
    HermesChatClient requestedClient
  ) {
    return generation == profileGeneration
      && attempt == connectionAttempt
      && requestedProfileId.equals(profileId)
      && requestedClient == client;
  }

  private static String fingerprint(String value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(
      value.getBytes(StandardCharsets.UTF_8)
    );
    return Base64.getEncoder().encodeToString(digest);
  }

  private static String message(Exception error) {
    String value = error.getMessage();
    return value == null || value.trim().isEmpty() ? "无法连接 Hermes。" : value;
  }

  private static <T> void appendBounded(ArrayDeque<T> queue, T value) {
    while (queue.size() >= MAX_PENDING_EVENTS) queue.removeFirst();
    queue.addLast(value);
  }

  private static final class Acknowledgement {
    final String messageId;
    final long sequence;

    Acknowledgement(String messageId, long sequence) {
      this.messageId = messageId;
      this.sequence = sequence;
    }
  }
}
