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
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/** Keeps one routed WebSocket alive for every locally configured Hermes profile. */
final class HermesChatConnectionManager {
  interface Listener {
    void onConnecting();
    void onReady();
    void onMessage(HermesChatCrypto.ChatMessage message);
    void onAcknowledged(String messageId, long sequence);
    void onActionAcknowledged(String actionId, boolean delivered);
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
  private static final long PERSISTENCE_BATCH_DELAY_MS = 40L;
  private static final long AWAITING_RESPONSE_TIMEOUT_MS = 120_000L;
  private static final long AGENT_TYPING_TIMEOUT_MS = 6_000L;
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
  private final HermesChatNotifications notifications;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final Map<String, ProfileSession> sessions = new LinkedHashMap<>();
  private final Set<UnreadListener> unreadListeners = new CopyOnWriteArraySet<>();
  private final AtomicLong awaitingRequestIds = new AtomicLong();
  private final AtomicLong profileRevisionIds = new AtomicLong();
  private final Map<String, Long> profileRevisions = new LinkedHashMap<>();

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
    notifications = new HermesChatNotifications(applicationContext);
    ensureClient();
    List<Models.HermesChatProfile> cachedProfiles = new HermesChatProfileStore(
      applicationContext
    ).load();
    if (!cachedProfiles.isEmpty()) syncProfiles(cachedProfiles);
  }

  void syncProfiles(List<Models.HermesChatProfile> profiles) {
    List<Models.HermesChatProfile> requested = List.copyOf(profiles);
    long syncAttempt = ++profileSyncAttempt;
    Map<String, Long> baselineRevisions = new LinkedHashMap<>(profileRevisions);
    Map<String, Long> requestedRevisions = new LinkedHashMap<>();
    Set<String> requestedIds = new HashSet<>();
    for (Models.HermesChatProfile profile : requested) {
      requestedIds.add(profile.id);
      requestedRevisions.put(profile.id, profileRevisions.getOrDefault(profile.id, 0L));
    }
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
            profile.label,
            fingerprint(encodedKey),
            crypto,
            history,
            snapshot.lastSequence,
            requestedRevisions.getOrDefault(profile.id, 0L)
          ));
          allowedIds.add(profile.id);
        } catch (Exception ignored) {
          // A malformed local key stays isolated to its profile and can be replaced in chat settings.
        }
      }
      handler.post(() -> applyProfileSync(
        syncAttempt,
        baselineRevisions,
        requestedIds,
        requestedRevisions,
        allowedIds,
        configs
      ));
    });
  }

  void attach(
    String profileId,
    String profileLabel,
    String encodedKey,
    long initialSequence,
    Listener requestedListener
  ) throws Exception {
    if (requestedListener == null) throw new IllegalArgumentException("聊天监听器不能为空。");
    String requestedFingerprint = fingerprint(encodedKey);
    ProfileSession session = sessions.get(profileId);
    boolean changed = session == null || !requestedFingerprint.equals(session.keyFingerprint);
    if (changed) {
      profileRevisions.put(profileId, profileRevisionIds.incrementAndGet());
      if (session != null) retireReplacedSession(session);
      HermesChatCrypto crypto = new HermesChatCrypto(encodedKey);
      session = new ProfileSession(
        profileId,
        profileLabel,
        requestedFingerprint,
        crypto,
        new HermesChatHistoryStore(context, profileId, crypto),
        initialSequence
      );
      sessions.put(profileId, session);
    } else {
      session.profileLabel = profileLabel;
      session.lastSequence = Math.max(session.lastSequence, initialSequence);
    }
    session.listener = requestedListener;
    session.visible = true;
    configureClientProfile(session);
    clearUnread(profileId);
    publishBusyState(session);
    publishState(session);
    drainPendingEvents(session);
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
      publishBusyState(session);
      publishState(session);
      drainPendingEvents(session);
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
    for (ProfileSession session : sessions.values()) {
      notifications.cancel(session.profileId);
      session.listener = null;
      session.visible = false;
      cancelAwaiting(session);
      cancelAgentTyping(session);
      flushMessagePersistence(session);
    }
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

  boolean isCurrentProfile(String profileId, String sessionToken) {
    ProfileSession session = sessions.get(profileId);
    return session != null && session.keyFingerprint.equals(sessionToken);
  }

  String profileSessionToken(String profileId) {
    ProfileSession session = sessions.get(profileId);
    return session == null ? null : session.keyFingerprint;
  }

  HermesChatCrypto.ChatMessage sendMessage(
    String profileId,
    String text,
    JSONArray attachments
  ) throws Exception {
    return sendMessage(profileId, text, attachments, null);
  }

  HermesChatCrypto.ChatMessage sendMessage(
    String profileId,
    String text,
    JSONArray attachments,
    String expectedSessionToken
  ) throws Exception {
    if (!isReady(profileId)) throw new IllegalStateException("聊天连接尚未就绪。");
    ProfileSession session = sessions.get(profileId);
    if (expectedSessionToken != null
        && !session.keyFingerprint.equals(expectedSessionToken)) {
      throw new IllegalStateException("Hermes 聊天密钥已更改，请重新发送附件。");
    }
    long awaitingRequestId = beginAwaitingAgentResponse(session);
    HermesChatCrypto.ChatMessage message;
    try {
      message = client.sendMessage(profileId, text, attachments, expectedSessionToken);
    } catch (Exception error) {
      rollbackAwaitingAgentResponse(session, awaitingRequestId);
      throw error;
    }
    persistMessage(session, message);
    return message;
  }

  String sendInteractionAction(
    String profileId,
    String promptId,
    String optionId
  ) throws Exception {
    if (!isReady(profileId)) throw new IllegalStateException("聊天连接尚未就绪。");
    ProfileSession session = sessions.get(profileId);
    long awaitingRequestId = beginAwaitingAgentResponse(session);
    String actionId = UUID.randomUUID().toString();
    session.actionAwaitingRequestIds.put(actionId, awaitingRequestId);
    try {
      return client.sendInteractionAction(profileId, promptId, optionId, actionId);
    } catch (Exception error) {
      session.actionAwaitingRequestIds.remove(actionId);
      rollbackAwaitingAgentResponse(session, awaitingRequestId);
      throw error;
    }
  }

  void sendTyping(String profileId, boolean active) {
    if (isReady(profileId)) client.sendTyping(profileId, active);
  }

  private void applyProfileSync(
    long syncAttempt,
    Map<String, Long> baselineRevisions,
    Set<String> requestedIds,
    Map<String, Long> requestedRevisions,
    Set<String> allowedIds,
    List<ProfileConfig> configs
  ) {
    if (syncAttempt != profileSyncAttempt) return;
    boolean changed = false;
    List<String> removedProfileIds = new ArrayList<>();
    for (String profileId : sessions.keySet()) {
      long currentRevision = profileRevisions.getOrDefault(profileId, 0L);
      Long baselineRevision = baselineRevisions.get(profileId);
      boolean removedRemotelyAtCapturedRevision = !requestedIds.contains(profileId)
        && baselineRevision != null
        && baselineRevision == currentRevision;
      boolean missingKeyAtCapturedRevision = !allowedIds.contains(profileId)
        && requestedRevisions.getOrDefault(profileId, 0L) == currentRevision;
      if (removedRemotelyAtCapturedRevision || missingKeyAtCapturedRevision) {
        removedProfileIds.add(profileId);
      }
    }
    for (String profileId : removedProfileIds) {
      ProfileSession removed = sessions.remove(profileId);
      if (removed != null) {
        profileRevisions.remove(profileId);
        notifications.cancel(profileId);
        removed.listener = null;
        removed.visible = false;
        cancelAwaiting(removed);
        cancelAgentTyping(removed);
        flushMessagePersistence(removed);
        changed = true;
      }
    }
    for (ProfileConfig config : configs) {
      long currentRevision = profileRevisions.getOrDefault(config.profileId, 0L);
      if (config.profileRevision != currentRevision) continue;
      ProfileSession existing = sessions.get(config.profileId);
      if (existing != null && existing.keyFingerprint.equals(config.keyFingerprint)) {
        existing.profileLabel = config.profileLabel;
        existing.lastSequence = Math.max(existing.lastSequence, config.lastSequence);
        configureClientProfile(existing);
        continue;
      }
      if (existing != null) retireReplacedSession(existing);
      profileRevisions.put(config.profileId, profileRevisionIds.incrementAndGet());
      ProfileSession replacement = new ProfileSession(
        config.profileId,
        config.profileLabel,
        config.keyFingerprint,
        config.crypto,
        config.history,
        config.lastSequence
      );
      sessions.put(config.profileId, replacement);
      changed = true;
    }
    ensureClient();
    client.retainProfiles(new HashSet<>(sessions.keySet()));
    for (ProfileSession session : sessions.values()) configureClientProfile(session);
    publishAllBusyStates();
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
        if (!authenticated || !api.hasCsrfToken()) {
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
        if (error instanceof NotesApiClient.ApiException) {
          int status = ((NotesApiClient.ApiException) error).status;
          if (status == 401 || status == 403) authenticated = false;
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
        HermesChatCrypto.ChatMessage message,
        String sessionToken
      ) {
        handler.post(() -> handleMessage(profileId, message, sessionToken));
      }

      @Override public void onAcknowledged(
        String profileId,
        String messageId,
        long sequence,
        String sessionToken
      ) {
        handler.post(() -> handleAcknowledged(profileId, messageId, sequence, sessionToken));
      }

      @Override public void onActionAcknowledged(
        String profileId,
        String actionId,
        boolean delivered,
        String sessionToken
      ) {
        handler.post(
          () -> handleActionAcknowledged(profileId, actionId, delivered, sessionToken)
        );
      }

      @Override public void onTyping(
        String profileId,
        boolean active,
        boolean terminal,
        String sessionToken
      ) {
        handler.post(() -> handleTyping(profileId, active, terminal, sessionToken));
      }

      @Override public void onProfileError(
        String profileId,
        String reason,
        String sessionToken
      ) {
        handler.post(() -> handleProfileError(profileId, reason, sessionToken));
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
      session.keyFingerprint,
      session.lastSequence
    );
  }

  private void handleReady(long generation) {
    if (generation != profileGeneration || client == null) return;
    state = State.READY;
    cancelReconnect();
    reconnectAttempt = 0;
    publishAllBusyStates();
    publishAllStates();
  }

  private void handleMessage(
    String profileId,
    HermesChatCrypto.ChatMessage message,
    String sessionToken
  ) {
    ProfileSession session = currentSession(profileId, sessionToken);
    if (session == null) return;
    session.lastSequence = Math.max(session.lastSequence, message.sequence);
    queueMessagePersistence(session, message);
    if ("agent".equals(message.sender)) {
      cancelAwaiting(session);
      cancelAgentTyping(session);
      publishBusyState(session);
      if (!session.visible && message.replaceSequence == 0) {
        int unreadCount = unreadStore.increment(profileId);
        notifications.showMessage(profileId, session.profileLabel, unreadCount, message);
        notifyUnread(profileId, unreadCount);
      }
    }
    if (session.listener != null && session.visible) session.listener.onMessage(message);
    else appendBounded(session.pendingMessages, message);
  }

  private void handleAcknowledged(
    String profileId,
    String messageId,
    long sequence,
    String sessionToken
  ) {
    ProfileSession session = currentSession(profileId, sessionToken);
    if (session == null) return;
    session.lastSequence = Math.max(session.lastSequence, sequence);
    if (sequence > 0) executor.submit(() -> session.history.acknowledge(messageId, sequence));
    if (session.listener != null && session.visible) {
      session.listener.onAcknowledged(messageId, sequence);
    } else {
      appendBounded(session.pendingAcknowledgements, new Acknowledgement(messageId, sequence));
    }
  }

  private void handleActionAcknowledged(
    String profileId,
    String actionId,
    boolean delivered,
    String sessionToken
  ) {
    ProfileSession session = currentSession(profileId, sessionToken);
    if (session == null) return;
    Long awaitingRequestId = session.actionAwaitingRequestIds.remove(actionId);
    if (!delivered && awaitingRequestId != null
        && session.awaitingRequestId == awaitingRequestId) {
      cancelAgentTyping(session);
      rollbackAwaitingAgentResponse(session, awaitingRequestId);
    }
    if (session.listener != null && session.visible) {
      session.listener.onActionAcknowledged(actionId, delivered);
    }
  }

  private void handleTyping(
    String profileId,
    boolean active,
    boolean terminal,
    String sessionToken
  ) {
    ProfileSession session = currentSession(profileId, sessionToken);
    if (session == null) return;
    if (active) {
      markAgentTyping(session);
    } else {
      cancelAgentTyping(session);
      if (terminal) cancelAwaiting(session);
      publishBusyState(session);
    }
  }

  private void handleProfileError(String profileId, String reason, String sessionToken) {
    ProfileSession session = currentSession(profileId, sessionToken);
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
    for (ProfileSession session : sessions.values()) {
      cancelAgentTyping(session);
      publishBusyState(session);
    }
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

  private ProfileSession currentSession(String profileId, String sessionToken) {
    ProfileSession session = sessions.get(profileId);
    return session != null && session.keyFingerprint.equals(sessionToken) ? session : null;
  }

  private void publishAllStates() {
    for (ProfileSession session : sessions.values()) publishState(session);
  }

  private void publishAllBusyStates() {
    for (ProfileSession session : sessions.values()) publishBusyState(session);
  }

  private void publishState(ProfileSession session) {
    Listener target = session.listener;
    if (target == null || !session.visible) return;
    if (state == State.READY) target.onReady();
    else if (state == State.CONNECTING) target.onConnecting();
    else if (state == State.DISCONNECTED) target.onDisconnected(disconnectReason);
  }

  private void publishBusyState(ProfileSession session) {
    Listener target = session.listener;
    if (target != null && session.visible) target.onTyping(session.isBusy());
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

  private void queueMessagePersistence(
    ProfileSession session,
    HermesChatCrypto.ChatMessage message
  ) {
    session.pendingPersistence.add(message);
    if (session.flushPersistence != null) return;
    session.flushPersistence = () -> flushMessagePersistence(session);
    handler.postDelayed(session.flushPersistence, PERSISTENCE_BATCH_DELAY_MS);
  }

  private void flushMessagePersistence(ProfileSession session) {
    if (session.flushPersistence != null) {
      handler.removeCallbacks(session.flushPersistence);
      session.flushPersistence = null;
    }
    if (session.pendingPersistence.isEmpty()) return;
    List<HermesChatCrypto.ChatMessage> batch = new ArrayList<>(session.pendingPersistence);
    session.pendingPersistence.clear();
    executor.submit(() -> session.history.recordBatch(batch));
  }

  private void discardMessagePersistence(ProfileSession session) {
    if (session.flushPersistence != null) {
      handler.removeCallbacks(session.flushPersistence);
      session.flushPersistence = null;
    }
    session.pendingPersistence.clear();
  }

  private long beginAwaitingAgentResponse(ProfileSession session) {
    long requestId = awaitingRequestIds.incrementAndGet();
    if (session == null) return requestId;
    if (Looper.myLooper() == handler.getLooper()) {
      if (sessions.get(session.profileId) == session) {
        markAwaitingAgentResponse(session, requestId);
      }
      return requestId;
    }
    handler.post(() -> {
      if (sessions.get(session.profileId) == session) {
        markAwaitingAgentResponse(session, requestId);
      }
    });
    return requestId;
  }

  private void markAwaitingAgentResponse(ProfileSession session, long requestId) {
    long generation = ++session.awaitingGeneration;
    session.awaitingRequestId = requestId;
    session.awaitingAgentResponse = true;
    if (session.expireAwaiting != null) handler.removeCallbacks(session.expireAwaiting);
    session.expireAwaiting = () -> {
      if (session.awaitingGeneration != generation) return;
      session.awaitingRequestId = 0;
      session.awaitingAgentResponse = false;
      session.actionAwaitingRequestIds.clear();
      session.expireAwaiting = null;
      publishBusyState(session);
    };
    handler.postDelayed(session.expireAwaiting, AWAITING_RESPONSE_TIMEOUT_MS);
    publishBusyState(session);
  }

  private void cancelAwaiting(ProfileSession session) {
    session.awaitingGeneration += 1;
    session.awaitingRequestId = 0;
    session.awaitingAgentResponse = false;
    session.actionAwaitingRequestIds.clear();
    if (session.expireAwaiting != null) handler.removeCallbacks(session.expireAwaiting);
    session.expireAwaiting = null;
  }

  private void rollbackAwaitingAgentResponse(ProfileSession session, long requestId) {
    if (session == null) return;
    Runnable rollback = () -> {
      if (sessions.get(session.profileId) != session
          || session.awaitingRequestId != requestId) return;
      cancelAwaiting(session);
      publishBusyState(session);
    };
    if (Looper.myLooper() == handler.getLooper()) rollback.run();
    else handler.post(rollback);
  }

  private void markAgentTyping(ProfileSession session) {
    long generation = ++session.typingGeneration;
    session.agentTypingActive = true;
    if (session.expireTyping != null) handler.removeCallbacks(session.expireTyping);
    session.expireTyping = () -> {
      if (session.typingGeneration != generation) return;
      session.agentTypingActive = false;
      session.expireTyping = null;
      publishBusyState(session);
    };
    handler.postDelayed(session.expireTyping, AGENT_TYPING_TIMEOUT_MS);
    publishBusyState(session);
  }

  private void cancelAgentTyping(ProfileSession session) {
    session.typingGeneration += 1;
    session.agentTypingActive = false;
    if (session.expireTyping != null) handler.removeCallbacks(session.expireTyping);
    session.expireTyping = null;
  }

  private void retireReplacedSession(ProfileSession session) {
    session.listener = null;
    session.visible = false;
    cancelAwaiting(session);
    cancelAgentTyping(session);
    discardMessagePersistence(session);
  }

  private void clearUnread(String profileId) {
    notifications.cancel(profileId);
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
    final String profileLabel;
    final String keyFingerprint;
    final HermesChatCrypto crypto;
    final HermesChatHistoryStore history;
    final long lastSequence;
    final long profileRevision;

    ProfileConfig(
      String profileId,
      String profileLabel,
      String keyFingerprint,
      HermesChatCrypto crypto,
      HermesChatHistoryStore history,
      long lastSequence,
      long profileRevision
    ) {
      this.profileId = profileId;
      this.profileLabel = profileLabel;
      this.keyFingerprint = keyFingerprint;
      this.crypto = crypto;
      this.history = history;
      this.lastSequence = lastSequence;
      this.profileRevision = profileRevision;
    }
  }

  private static final class ProfileSession {
    final String profileId;
    String profileLabel;
    final String keyFingerprint;
    final HermesChatCrypto crypto;
    final HermesChatHistoryStore history;
    final ArrayDeque<HermesChatCrypto.ChatMessage> pendingMessages = new ArrayDeque<>();
    final ArrayDeque<Acknowledgement> pendingAcknowledgements = new ArrayDeque<>();
    final List<HermesChatCrypto.ChatMessage> pendingPersistence = new ArrayList<>();
    final Map<String, Long> actionAwaitingRequestIds = new LinkedHashMap<>();
    long lastSequence;
    Listener listener;
    boolean visible;
    boolean awaitingAgentResponse;
    boolean agentTypingActive;
    long awaitingRequestId;
    long awaitingGeneration;
    long typingGeneration;
    Runnable expireAwaiting;
    Runnable expireTyping;
    Runnable flushPersistence;

    ProfileSession(
      String profileId,
      String profileLabel,
      String keyFingerprint,
      HermesChatCrypto crypto,
      HermesChatHistoryStore history,
      long lastSequence
    ) {
      this.profileId = profileId;
      this.profileLabel = profileLabel;
      this.keyFingerprint = keyFingerprint;
      this.crypto = crypto;
      this.history = history;
      this.lastSequence = Math.max(0, lastSequence);
    }

    boolean isBusy() {
      return awaitingAgentResponse || agentTypingActive;
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
