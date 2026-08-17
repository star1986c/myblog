package io.qzz.superstar1014.mynotes;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;

/** Keeps one routed WebSocket alive for every locally configured Hermes profile. */
final class HermesChatConnectionManager {
  interface Listener {
    void onConnecting();
    void onReady();
    void onMessage(HermesChatCrypto.ChatMessage message);
    void onAcknowledged(String messageId, long sequence);
    void onTyping(boolean active);
    void onDisconnected(String reason);
  }

  interface UnreadListener {
    void onUnreadChanged(String profileId, int unreadCount);
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

  private final Context context;
  private final NotesApiClient api;
  private final SecureSessionStore secureStore;
  private final HermesChatUnreadStore unreadStore;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Map<String, ProfileSession> sessions = new LinkedHashMap<>();
  private final Set<UnreadListener> unreadListeners = new CopyOnWriteArraySet<>();

  private HermesChatClient client;
  private State state = State.IDLE;
  private String disconnectReason = "聊天连接已断开。";
  private long profileGeneration;
  private long connectionAttempt;
  private long profileSyncAttempt;
  private int reconnectAttempt;
  private volatile boolean authenticated;
  private Runnable reconnectTask;

  private HermesChatConnectionManager(Context applicationContext) {
    context = applicationContext;
    api = new NotesApiClient(applicationContext);
    secureStore = new SecureSessionStore(applicationContext);
    unreadStore = new HermesChatUnreadStore(applicationContext);
    ensureClient();
    List<Models.HermesChatProfile> cachedProfiles = new HermesChatProfileStore(
      applicationContext
    ).load();
    if (!cachedProfiles.isEmpty()) syncProfiles(cachedProfiles);
  }

  void syncProfiles(List<Models.HermesChatProfile> profiles) {
    List<Models.HermesChatProfile> requested = List.copyOf(profiles);
    long syncAttempt = ++profileSyncAttempt;
    executor.submit(() -> {
      List<ProfileConfig> configs = new ArrayList<>();
      Set<String> allowedIds = new HashSet<>();
      for (Models.HermesChatProfile profile : requested) {
        String encodedKey = secureStore.loadHermesChatKey(profile.id);
        if (encodedKey.isEmpty()) continue;
        try {
          HermesChatCrypto crypto = new HermesChatCrypto(encodedKey);
          HermesChatHistoryStore history = new HermesChatHistoryStore(context, profile.id, crypto);
          HermesChatHistoryStore.Snapshot snapshot = history.loadAndCleanup(
            HermesChatCacheSettings.retentionDays(context),
            System.currentTimeMillis()
          );
          configs.add(new ProfileConfig(
            profile.id,
            fingerprint(encodedKey),
            crypto,
            history,
            snapshot.lastSequence
          ));
          allowedIds.add(profile.id);
        } catch (Exception ignored) {
          // A malformed local key stays isolated to its profile and can be replaced in chat settings.
        }
      }
      handler.post(() -> applyProfileSync(syncAttempt, allowedIds, configs));
    });
  }

  void attach(
    String profileId,
    String encodedKey,
    long initialSequence,
    Listener requestedListener
  ) throws Exception {
    if (requestedListener == null) throw new IllegalArgumentException("聊天监听器不能为空。");
    String requestedFingerprint = fingerprint(encodedKey);
    ProfileSession session = sessions.get(profileId);
    boolean changed = session == null || !requestedFingerprint.equals(session.keyFingerprint);
    if (changed) {
      HermesChatCrypto crypto = new HermesChatCrypto(encodedKey);
      session = new ProfileSession(
        profileId,
        requestedFingerprint,
        crypto,
        new HermesChatHistoryStore(context, profileId, crypto),
        initialSequence
      );
      sessions.put(profileId, session);
    } else {
      session.lastSequence = Math.max(session.lastSequence, initialSequence);
    }
    session.listener = requestedListener;
    session.visible = true;
    configureClientProfile(session);
    clearUnread(profileId);
    publishState(session);
    drainPendingEvents(session);
    if (session.awaitingAgentResponse) requestedListener.onTyping(true);
    if (changed || state == State.IDLE || state == State.DISCONNECTED) {
      profileGeneration += 1;
      authenticateAndConnect(profileGeneration);
    }
  }

  void detach(Listener candidate) {
    for (ProfileSession session : sessions.values()) {
      if (session.listener != candidate) continue;
      session.listener = null;
      session.visible = false;
    }
  }

  void setProfileVisible(String profileId, Listener candidate, boolean visible) {
    ProfileSession session = sessions.get(profileId);
    if (session == null || session.listener != candidate) return;
    session.visible = visible;
    if (visible) {
      clearUnread(profileId);
      publishState(session);
      drainPendingEvents(session);
      if (session.awaitingAgentResponse) candidate.onTyping(true);
    }
  }

  void addUnreadListener(UnreadListener listener) {
    if (listener != null) unreadListeners.add(listener);
  }

  void removeUnreadListener(UnreadListener listener) {
    unreadListeners.remove(listener);
  }

  int unreadCount(String profileId) {
    return unreadStore.get(profileId);
  }

  void markAuthenticated() {
    authenticated = true;
  }

  void reconnect() {
    if (sessions.isEmpty()) return;
    cancelReconnect();
    authenticateAndConnect(profileGeneration);
  }

  void shutdown() {
    cancelReconnect();
    for (ProfileSession session : sessions.values()) cancelAwaiting(session);
    sessions.clear();
    if (client != null) client.shutdown();
    client = null;
    state = State.IDLE;
    disconnectReason = "聊天连接已断开。";
    reconnectAttempt = 0;
    authenticated = false;
    profileGeneration += 1;
    connectionAttempt += 1;
  }

  boolean isReady() {
    return state == State.READY && client != null && client.isConnected();
  }

  boolean isReady(String profileId) {
    return isReady() && sessions.containsKey(profileId);
  }

  boolean isCurrentProfile(String profileId) {
    return profileId != null && sessions.containsKey(profileId);
  }

  HermesChatCrypto.ChatMessage sendMessage(
    String profileId,
    String text,
    JSONArray attachments
  ) throws Exception {
    if (!isReady(profileId)) throw new IllegalStateException("聊天连接尚未就绪。");
    ProfileSession session = sessions.get(profileId);
    HermesChatCrypto.ChatMessage message = client.sendMessage(profileId, text, attachments);
    persistMessage(session, message);
    markAwaitingAgentResponse(session);
    return message;
  }

  void sendTyping(String profileId, boolean active) {
    if (isReady(profileId)) client.sendTyping(profileId, active);
  }

  private void applyProfileSync(
    long syncAttempt,
    Set<String> allowedIds,
    List<ProfileConfig> configs
  ) {
    if (syncAttempt != profileSyncAttempt) return;
    boolean changed = false;
    List<String> removedProfileIds = new ArrayList<>();
    for (String profileId : sessions.keySet()) {
      if (!allowedIds.contains(profileId)) removedProfileIds.add(profileId);
    }
    for (String profileId : removedProfileIds) {
      ProfileSession removed = sessions.remove(profileId);
      if (removed != null) {
        cancelAwaiting(removed);
        changed = true;
      }
    }
    for (ProfileConfig config : configs) {
      ProfileSession existing = sessions.get(config.profileId);
      if (existing != null && existing.keyFingerprint.equals(config.keyFingerprint)) {
        existing.lastSequence = Math.max(existing.lastSequence, config.lastSequence);
        configureClientProfile(existing);
        continue;
      }
      sessions.put(config.profileId, new ProfileSession(
        config.profileId,
        config.keyFingerprint,
        config.crypto,
        config.history,
        config.lastSequence
      ));
      changed = true;
    }
    ensureClient();
    client.retainProfiles(new HashSet<>(sessions.keySet()));
    for (ProfileSession session : sessions.values()) configureClientProfile(session);
    if (sessions.isEmpty()) {
      client.close();
      state = State.IDLE;
      return;
    }
    if (changed || state == State.IDLE || state == State.DISCONNECTED) {
      profileGeneration += 1;
      authenticateAndConnect(profileGeneration);
    }
  }

  private void authenticateAndConnect(long generation) {
    if (generation != profileGeneration || sessions.isEmpty()) return;
    cancelReconnect();
    ensureClient();
    state = State.CONNECTING;
    publishAllStates();
    long attempt = ++connectionAttempt;
    List<String> targetProfiles = new ArrayList<>(sessions.keySet());
    HermesChatClient targetClient = client;
    executor.submit(() -> {
      try {
        if (!authenticated) {
          NotesApiClient.SessionResult session = api.restoreSession();
          if (!session.authenticated) throw new IllegalStateException("请先在 My Notes 登录。");
          authenticated = true;
        }
        Models.HermesChatMultiplexTicket ticket = api.hermesChatMultiplexTicket(targetProfiles);
        handler.post(() -> {
          if (!matches(generation, attempt, targetProfiles, targetClient)) return;
          targetClient.connect(ticket);
        });
      } catch (Exception error) {
        if (error instanceof NotesApiClient.ApiException
            && ((NotesApiClient.ApiException) error).status == 401) {
          authenticated = false;
        }
        handler.post(() -> {
          if (!matches(generation, attempt, targetProfiles, targetClient)) return;
          handleDisconnected(generation, message(error));
        });
      }
    });
  }

  private void ensureClient() {
    if (client != null) return;
    client = new HermesChatClient(new HermesChatClient.Listener() {
      @Override public void onReady() {
        handler.post(() -> handleReady(profileGeneration));
      }

      @Override public void onMessage(
        String profileId,
        HermesChatCrypto.ChatMessage message
      ) {
        handler.post(() -> handleMessage(profileId, message));
      }

      @Override public void onAcknowledged(
        String profileId,
        String messageId,
        long sequence
      ) {
        handler.post(() -> handleAcknowledged(profileId, messageId, sequence));
      }

      @Override public void onTyping(String profileId, boolean active) {
        handler.post(() -> handleTyping(profileId, active));
      }

      @Override public void onProfileError(String profileId, String reason) {
        handler.post(() -> handleProfileError(profileId, reason));
      }

      @Override public void onDisconnected(String reason) {
        handler.post(() -> handleDisconnected(profileGeneration, reason));
      }
    });
  }

  private void configureClientProfile(ProfileSession session) {
    ensureClient();
    client.configureProfile(
      session.profileId,
      session.crypto,
      session.lastSequence
    );
  }

  private void handleReady(long generation) {
    if (generation != profileGeneration || client == null) return;
    state = State.READY;
    cancelReconnect();
    reconnectAttempt = 0;
    publishAllStates();
  }

  private void handleMessage(String profileId, HermesChatCrypto.ChatMessage message) {
    ProfileSession session = sessions.get(profileId);
    if (session == null) return;
    session.lastSequence = Math.max(session.lastSequence, message.sequence);
    persistMessage(session, message);
    if ("agent".equals(message.sender)) {
      cancelAwaiting(session);
      if (!session.visible && message.replaceSequence == 0) {
        notifyUnread(profileId, unreadStore.increment(profileId));
      }
    }
    if (session.listener != null && session.visible) session.listener.onMessage(message);
    else appendBounded(session.pendingMessages, message);
  }

  private void handleAcknowledged(String profileId, String messageId, long sequence) {
    ProfileSession session = sessions.get(profileId);
    if (session == null) return;
    session.lastSequence = Math.max(session.lastSequence, sequence);
    if (sequence > 0) executor.submit(() -> session.history.acknowledge(messageId, sequence));
    if (session.listener != null && session.visible) {
      session.listener.onAcknowledged(messageId, sequence);
    } else {
      appendBounded(session.pendingAcknowledgements, new Acknowledgement(messageId, sequence));
    }
  }

  private void handleTyping(String profileId, boolean active) {
    ProfileSession session = sessions.get(profileId);
    if (session == null || !active) return;
    markAwaitingAgentResponse(session);
    if (session.listener != null && session.visible) session.listener.onTyping(true);
  }

  private void handleProfileError(String profileId, String reason) {
    ProfileSession session = sessions.get(profileId);
    if (session == null || session.listener == null || !session.visible) return;
    session.listener.onDisconnected(reason);
    if (state == State.READY) handler.postDelayed(() -> {
      if (session.listener != null && session.visible && state == State.READY) {
        session.listener.onReady();
      }
    }, 800L);
  }

  private void handleDisconnected(long generation, String reason) {
    if (generation != profileGeneration || client == null) return;
    if (state == State.DISCONNECTED && reconnectTask != null) return;
    state = State.DISCONNECTED;
    disconnectReason = reason == null || reason.trim().isEmpty()
      ? "聊天连接已断开。"
      : reason;
    publishAllStates();
    long baseDelay = Math.min(45_000L, 2_000L << Math.min(reconnectAttempt, 4));
    long jitter = ThreadLocalRandom.current().nextLong(Math.max(1L, baseDelay / 4));
    reconnectAttempt += 1;
    reconnectTask = () -> {
      reconnectTask = null;
      if (generation == profileGeneration && !sessions.isEmpty()) {
        authenticateAndConnect(generation);
      }
    };
    handler.postDelayed(reconnectTask, baseDelay + jitter);
  }

  private void publishAllStates() {
    for (ProfileSession session : sessions.values()) publishState(session);
  }

  private void publishState(ProfileSession session) {
    Listener target = session.listener;
    if (target == null || !session.visible) return;
    if (state == State.READY) target.onReady();
    else if (state == State.CONNECTING) target.onConnecting();
    else if (state == State.DISCONNECTED) target.onDisconnected(disconnectReason);
  }

  private void drainPendingEvents(ProfileSession session) {
    Listener target = session.listener;
    if (target == null || !session.visible) return;
    while (!session.pendingAcknowledgements.isEmpty()) {
      Acknowledgement acknowledgement = session.pendingAcknowledgements.removeFirst();
      target.onAcknowledged(acknowledgement.messageId, acknowledgement.sequence);
    }
    while (!session.pendingMessages.isEmpty()) target.onMessage(session.pendingMessages.removeFirst());
  }

  private void persistMessage(ProfileSession session, HermesChatCrypto.ChatMessage message) {
    executor.submit(() -> session.history.record(message));
  }

  private void markAwaitingAgentResponse(ProfileSession session) {
    session.awaitingAgentResponse = true;
    if (session.expireAwaiting != null) handler.removeCallbacks(session.expireAwaiting);
    session.expireAwaiting = () -> {
      session.awaitingAgentResponse = false;
      session.expireAwaiting = null;
    };
    handler.postDelayed(session.expireAwaiting, AWAITING_RESPONSE_TIMEOUT_MS);
  }

  private void cancelAwaiting(ProfileSession session) {
    session.awaitingAgentResponse = false;
    if (session.expireAwaiting != null) handler.removeCallbacks(session.expireAwaiting);
    session.expireAwaiting = null;
  }

  private void clearUnread(String profileId) {
    if (unreadStore.get(profileId) == 0) return;
    unreadStore.clear(profileId);
    notifyUnread(profileId, 0);
  }

  private void notifyUnread(String profileId, int count) {
    for (UnreadListener listener : unreadListeners) listener.onUnreadChanged(profileId, count);
  }

  private void cancelReconnect() {
    if (reconnectTask == null) return;
    handler.removeCallbacks(reconnectTask);
    reconnectTask = null;
  }

  private boolean matches(
    long generation,
    long attempt,
    List<String> requestedProfiles,
    HermesChatClient requestedClient
  ) {
    return generation == profileGeneration
      && attempt == connectionAttempt
      && requestedProfiles.equals(new ArrayList<>(sessions.keySet()))
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

  private static final class ProfileConfig {
    final String profileId;
    final String keyFingerprint;
    final HermesChatCrypto crypto;
    final HermesChatHistoryStore history;
    final long lastSequence;

    ProfileConfig(
      String profileId,
      String keyFingerprint,
      HermesChatCrypto crypto,
      HermesChatHistoryStore history,
      long lastSequence
    ) {
      this.profileId = profileId;
      this.keyFingerprint = keyFingerprint;
      this.crypto = crypto;
      this.history = history;
      this.lastSequence = lastSequence;
    }
  }

  private static final class ProfileSession {
    final String profileId;
    final String keyFingerprint;
    final HermesChatCrypto crypto;
    final HermesChatHistoryStore history;
    final ArrayDeque<HermesChatCrypto.ChatMessage> pendingMessages = new ArrayDeque<>();
    final ArrayDeque<Acknowledgement> pendingAcknowledgements = new ArrayDeque<>();
    long lastSequence;
    Listener listener;
    boolean visible;
    boolean awaitingAgentResponse;
    Runnable expireAwaiting;

    ProfileSession(
      String profileId,
      String keyFingerprint,
      HermesChatCrypto crypto,
      HermesChatHistoryStore history,
      long lastSequence
    ) {
      this.profileId = profileId;
      this.keyFingerprint = keyFingerprint;
      this.crypto = crypto;
      this.history = history;
      this.lastSequence = Math.max(0, lastSequence);
    }
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
