import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const base = "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/";
const source = (name) => readFile(new URL(`${base}${name}`, import.meta.url), "utf8");

test("Hermes chat resumes from the encrypted per-profile local checkpoint", async () => {
  const [activity, client, manager, history] = await Promise.all([
    source("HermesChatActivity.java"),
    source("HermesChatClient.java"),
    source("HermesChatConnectionManager.java"),
    source("HermesChatHistoryStore.java"),
  ]);

  assert.match(history, /getNoBackupFilesDir\(\)/);
  assert.match(history, /encryptLocalSnapshot/);
  assert.match(history, /lastSequence/);
  assert.match(
    client,
    /ProfileState\([\s\S]*HermesChatCrypto crypto,[\s\S]*String keyFingerprint,[\s\S]*long initialSequence/,
  );
  assert.match(client, /this\.lastSequence = initialSequence/);
  assert.match(manager, /configureClientProfile\(session\)/);
  assert.match(manager, /session\.lastSequence/);
  assert.match(activity, /connection\.attach\([\s\S]*snapshot\.lastSequence/);
  assert.match(activity, /targetStore\.acknowledge\(messageId, sequence\)/);
});

test("Hermes keeps one routed socket for all cached profiles for the Android process lifetime", async () => {
  const [activity, client, manager, main, api] = await Promise.all([
    source("HermesChatActivity.java"),
    source("HermesChatClient.java"),
    source("HermesChatConnectionManager.java"),
    source("MainActivity.java"),
    source("NotesApiClient.java"),
  ]);
  const onDestroy = activity.slice(
    activity.indexOf("protected void onDestroy()"),
    activity.indexOf("protected void onActivityResult"),
  );

  assert.match(manager, /static volatile HermesChatConnectionManager instance/);
  assert.match(manager, /context\.getApplicationContext\(\)/);
  assert.match(manager, /Map<String, ProfileSession> sessions/);
  assert.match(manager, /hermesChatMultiplexTicket\(targetProfiles\)/);
  assert.match(manager, /pendingMessages/);
  assert.match(manager, /handler\.postDelayed\(reconnectTask, baseDelay \+ jitter\)/);
  assert.match(manager, /!authenticated \|\| !api\.hasCsrfToken\(\)/);
  assert.match(manager, /status == 401 \|\| status == 403/);
  assert.match(api, /boolean hasCsrfToken\(\)/);
  assert.match(client, /\.header\("X-Hermes-Mode", "multiplex"\)/);
  assert.match(client, /frame\.put\("spaceId", spaceId\)/);
  assert.match(client, /if \(webSocket != socket\)[\s\S]*Replaced by a newer chat connection/);
  assert.doesNotMatch(manager, /closeUnless/);
  assert.match(onDestroy, /connection\.detach\(connectionListener\)/);
  assert.doesNotMatch(onDestroy, /shutdown\(\)/);
  assert.match(main, /private void logout\(\)[\s\S]*HermesChatConnectionManager\.get\(this\)\.shutdown\(\)/);
  assert.equal(
    (main.match(/HermesChatConnectionManager\.get\(this\)\.markAuthenticated\(\)/g) || []).length,
    2,
  );
});

test("Android abandons a WebSocket handshake that never reaches relay ready", async () => {
  const client = await source("HermesChatClient.java");

  assert.match(client, /HANDSHAKE_TIMEOUT_MS = 20_000L/);
  assert.match(client, /handler\.postDelayed\(handshakeTimeoutTask, HANDSHAKE_TIMEOUT_MS\)/);
  assert.match(
    client,
    /if \(socket != expectedSocket \|\| closing \|\| !handshakePending\) return;[\s\S]*socket = null;[\s\S]*expectedSocket\.cancel\(\);[\s\S]*WebSocket 握手超时，正在自动重试/,
  );
  assert.match(
    client,
    /if \("ready"\.equals\(type\)\) \{[\s\S]*cancelHandshakeTimeout\(webSocket\)[\s\S]*listener\.onReady\(\)/,
  );
  assert.match(client, /void close\(\) \{[\s\S]*cancelHandshakeTimeoutLocked\(\)/);
});

test("Android serializes remembered-device refresh without deleting Hermes keys", async () => {
  const [api, sessionStore] = await Promise.all([
    source("NotesApiClient.java"),
    source("SecureSessionStore.java"),
  ]);

  assert.match(api, /private static final Object SESSION_REFRESH_LOCK/);
  assert.match(
    api,
    /SessionResult restoreSession\(\) throws Exception \{\s*synchronized \(SESSION_REFRESH_LOCK\) \{[\s\S]*request\("GET", "api\/auth\/me", null, null\)/,
  );
  assert.match(
    api,
    /if \(token\.equals\(sessionStore\.loadDeviceToken\(\)\)\) \{\s*sessionStore\.clearAuthentication\(\);/,
  );
  assert.match(
    api,
    /firstPart\.equals\("site_admin_session="\)[\s\S]*sessionStore\.clearSessionCookie\(\)/,
  );
  assert.doesNotMatch(api, /sessionStore\.clear\(\)/);

  assert.match(
    sessionStore,
    /void clearSessionCookie\(\) \{\s*preferences\.edit\(\)\.remove\(COOKIE_KEY\)\.apply\(\);/,
  );
  assert.match(
    sessionStore,
    /void clearAuthentication\(\) \{[\s\S]*remove\(COOKIE_KEY\)[\s\S]*remove\(TOKEN_KEY\)[\s\S]*apply\(\)/,
  );
  assert.doesNotMatch(sessionStore, /preferences\.edit\(\)\.clear\(\)/);
});

test("Hermes keeps the routed socket in a non-sticky remote-messaging foreground service", async () => {
  const [service, manifest, main, activity, conversations] = await Promise.all([
    source("HermesChatConnectionService.java"),
    readFile(new URL("../android/MyNotes/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
    source("MainActivity.java"),
    source("HermesChatActivity.java"),
    source("HermesConversationsActivity.java"),
  ]);

  assert.match(service, /class HermesChatConnectionService extends Service/);
  assert.match(service, /FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING/);
  assert.match(service, /HermesChatConnectionManager\.get\(this\)\.syncProfiles/);
  assert.match(service, /return START_NOT_STICKY/);
  assert.match(service, /NotificationChannel/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_REMOTE_MESSAGING/);
  assert.match(
    manifest,
    /android:name="\.HermesChatConnectionService"[\s\S]*android:foregroundServiceType="remoteMessaging"[\s\S]*android:stopWithTask="false"/,
  );
  assert.equal(
    (main.match(/HermesChatConnectionService\.startIfConfigured\(this\)/g) || []).length,
    2,
  );
  assert.match(main, /private void logout\(\)[\s\S]*HermesChatConnectionService\.stop\(this\)/);
  assert.match(activity, /connection\.attach\([\s\S]*HermesChatConnectionService\.startIfConfigured\(this\)/);
  assert.match(conversations, /connection\.syncProfiles\(profiles\)[\s\S]*HermesChatConnectionService\.startIfConfigured\(this\)/);
});

test("inactive routed profiles persist messages and unread counts locally", async () => {
  const [manager, profiles, unread] = await Promise.all([
    source("HermesChatConnectionManager.java"),
    source("HermesChatProfileStore.java"),
    source("HermesChatUnreadStore.java"),
  ]);

  assert.match(manager, /persistMessage\(session, message\)/);
  assert.match(manager, /!session\.visible[\s\S]*unreadStore\.increment\(profileId\)/);
  assert.match(manager, /clearUnread\(profileId\)/);
  assert.match(profiles, /SharedPreferences/);
  assert.match(profiles, /List<Models\.HermesChatProfile> load\(\)/);
  assert.match(unread, /int increment\(String spaceId\)/);
});

test("late Agent typing self-heals in 6 seconds without reopening 120-second awaiting", async () => {
  const manager = await source("HermesChatConnectionManager.java");
  const handleTyping = manager.slice(
    manager.indexOf("private void handleTyping"),
    manager.indexOf("private void handleProfileError"),
  );
  const markAwaiting = manager.slice(
    manager.indexOf("private void markAwaitingAgentResponse"),
    manager.indexOf("private void cancelAwaiting"),
  );
  const markTyping = manager.slice(
    manager.indexOf("private void markAgentTyping"),
    manager.indexOf("private void cancelAgentTyping"),
  );

  assert.match(manager, /AWAITING_RESPONSE_TIMEOUT_MS = 120_000L/);
  assert.match(manager, /AGENT_TYPING_TIMEOUT_MS = 6_000L/);
  assert.match(handleTyping, /if \(active\) \{\s*markAgentTyping\(session\)/);
  assert.doesNotMatch(handleTyping, /if \(active\)[\s\S]*markAwaitingAgentResponse/);
  assert.match(
    markAwaiting,
    /session\.awaitingAgentResponse = true[\s\S]*handler\.postDelayed\(session\.expireAwaiting, AWAITING_RESPONSE_TIMEOUT_MS\)/,
  );
  assert.doesNotMatch(markTyping, /awaitingAgentResponse|expireAwaiting/);
  assert.match(
    markTyping,
    /typingGeneration[\s\S]*agentTypingActive = true[\s\S]*removeCallbacks\(session\.expireTyping\)[\s\S]*typingGeneration != generation[\s\S]*agentTypingActive = false[\s\S]*postDelayed\(session\.expireTyping, AGENT_TYPING_TIMEOUT_MS\)/,
  );
  assert.match(manager, /return awaitingAgentResponse \|\| agentTypingActive/);
});

test("Hermes stop and Agent messages clear both states while disconnect preserves awaiting", async () => {
  const manager = await source("HermesChatConnectionManager.java");
  const handleMessage = manager.slice(
    manager.indexOf("private void handleMessage"),
    manager.indexOf("private void handleAcknowledged"),
  );
  const handleTyping = manager.slice(
    manager.indexOf("private void handleTyping"),
    manager.indexOf("private void handleProfileError"),
  );
  const disconnect = manager.slice(
    manager.indexOf("private void handleDisconnected"),
    manager.indexOf("private void publishAllStates"),
  );

  assert.match(
    handleMessage,
    /"agent"\.equals\(message\.sender\)[\s\S]*cancelAwaiting\(session\)[\s\S]*cancelAgentTyping\(session\)[\s\S]*publishBusyState\(session\)/,
  );
  assert.match(
    handleTyping,
    /else \{\s*cancelAgentTyping\(session\);\s*if \(terminal\) cancelAwaiting\(session\);\s*publishBusyState\(session\)/,
  );
  assert.match(disconnect, /cancelAgentTyping\(session\)[\s\S]*publishBusyState\(session\)/);
  assert.doesNotMatch(disconnect, /cancelAwaiting\(session\)/);
});

test("Android distinguishes a typing fence from a terminal stop", async () => {
  const [client, manager] = await Promise.all([
    source("HermesChatClient.java"),
    source("HermesChatConnectionManager.java"),
  ]);
  const typingParser = client.slice(
    client.indexOf('if ("typing".equals(type)'),
    client.indexOf('if ("error".equals(type)'),
  );
  const handleTyping = manager.slice(
    manager.indexOf("private void handleTyping"),
    manager.indexOf("private void handleProfileError"),
  );

  assert.match(
    typingParser,
    /!active[\s\S]*!frame\.has\("terminal"\)[\s\S]*frame\.optBoolean\("terminal"\)/,
  );
  assert.match(handleTyping, /cancelAgentTyping\(session\)/);
  assert.match(handleTyping, /if \(terminal\) cancelAwaiting\(session\)/);
});

test("Hermes visibility restore publishes false and replaced sessions cannot fire stale timers", async () => {
  const manager = await source("HermesChatConnectionManager.java");
  const attach = manager.slice(
    manager.indexOf("void attach("),
    manager.indexOf("void detach("),
  );
  const visibility = manager.slice(
    manager.indexOf("void setProfileVisible"),
    manager.indexOf("void addUnreadListener"),
  );
  const applySync = manager.slice(
    manager.indexOf("private void applyProfileSync"),
    manager.indexOf("private void authenticateAndConnect"),
  );
  const retire = manager.slice(
    manager.indexOf("private void retireReplacedSession"),
    manager.indexOf("private void clearUnread"),
  );

  assert.match(attach, /publishBusyState\(session\);\s*publishState\(session\);\s*drainPendingEvents\(session\)/);
  assert.match(visibility, /publishBusyState\(session\);\s*publishState\(session\);\s*drainPendingEvents\(session\)/);
  assert.doesNotMatch(attach, /if \(session\.awaitingAgentResponse\)/);
  assert.doesNotMatch(visibility, /if \(session\.awaitingAgentResponse\)/);
  assert.match(
    retire,
    /session\.listener = null;\s*session\.visible = false;\s*cancelAwaiting\(session\);\s*cancelAgentTyping\(session\);\s*discardMessagePersistence\(session\)/,
  );
  assert.match(
    applySync,
    /config\.profileRevision != currentRevision\) continue;[\s\S]*if \(existing != null\) retireReplacedSession\(existing\)/,
  );
  assert.doesNotMatch(applySync, /transferredListener|transferredVisibility/);
  assert.match(
    attach,
    /profileRevisions\.put\(profileId, profileRevisionIds\.incrementAndGet\(\)\)/,
  );
});

test("outbound awaiting is ordered before network send so fast final or stop stays cleared", async () => {
  const manager = await source("HermesChatConnectionManager.java");
  const sendMessage = manager.slice(
    manager.indexOf("HermesChatCrypto.ChatMessage sendMessage"),
    manager.indexOf("String sendInteractionAction"),
  );
  const sendAction = manager.slice(
    manager.indexOf("String sendInteractionAction"),
    manager.indexOf("void sendTyping"),
  );
  const clientCallbacks = manager.slice(
    manager.indexOf("private void ensureClient"),
    manager.indexOf("private void configureClientProfile"),
  );
  const beginAwaiting = manager.slice(
    manager.indexOf("private long beginAwaitingAgentResponse"),
    manager.indexOf("private void markAwaitingAgentResponse"),
  );
  const rollbackAwaiting = manager.slice(
    manager.indexOf("private void rollbackAwaitingAgentResponse"),
    manager.indexOf("private void markAgentTyping"),
  );

  const messageBegin = sendMessage.indexOf("beginAwaitingAgentResponse(session)");
  const messageNetworkSend = sendMessage.indexOf("client.sendMessage");
  const actionBegin = sendAction.indexOf("beginAwaitingAgentResponse(session)");
  const actionNetworkSend = sendAction.indexOf("client.sendInteractionAction");

  assert.ok(messageBegin >= 0 && messageBegin < messageNetworkSend);
  assert.ok(actionBegin >= 0 && actionBegin < actionNetworkSend);
  assert.match(sendMessage, /catch \(Exception error\) \{\s*rollbackAwaitingAgentResponse\(session, awaitingRequestId\)/);
  assert.match(
    sendAction,
    /actionAwaitingRequestIds\.put\(actionId, awaitingRequestId\)[\s\S]*client\.sendInteractionAction\(profileId, promptId, optionId, actionId\)[\s\S]*catch \(Exception error\) \{\s*session\.actionAwaitingRequestIds\.remove\(actionId\);\s*rollbackAwaitingAgentResponse/,
  );
  assert.match(
    beginAwaiting,
    /handler\.post\(\(\) -> \{[\s\S]*markAwaitingAgentResponse\(session, requestId\)/,
  );
  assert.match(clientCallbacks, /onMessage[\s\S]*handler\.post\(\(\) -> handleMessage/);
  assert.match(clientCallbacks, /onTyping[\s\S]*handler\.post\(\(\) -> handleTyping/);
  assert.match(
    rollbackAwaiting,
    /session\.awaitingRequestId != requestId[\s\S]*cancelAwaiting\(session\)[\s\S]*publishBusyState\(session\)/,
  );
  assert.match(manager, /session\.awaitingRequestId = 0;[\s\S]*session\.awaitingAgentResponse = false/);
});

test("late negative action ACKs are scoped to their original awaiting request", async () => {
  const manager = await source("HermesChatConnectionManager.java");
  const handleAction = manager.slice(
    manager.indexOf("private void handleActionAcknowledged"),
    manager.indexOf("private void handleTyping"),
  );

  assert.match(
    handleAction,
    /actionAwaitingRequestIds\.remove\(actionId\)[\s\S]*session\.awaitingRequestId == awaitingRequestId[\s\S]*rollbackAwaitingAgentResponse\(session, awaitingRequestId\)/,
  );
  assert.doesNotMatch(handleAction, /cancelAwaiting\(session\)/);
});

test("stale profile sync and attachment uploads cannot cross a replacement key", async () => {
  const [client, manager] = await Promise.all([
    source("HermesChatClient.java"),
    source("HermesChatConnectionManager.java"),
  ]);
  const sync = manager.slice(
    manager.indexOf("void syncProfiles"),
    manager.indexOf("void attach("),
  );
  const applySync = manager.slice(
    manager.indexOf("private void applyProfileSync"),
    manager.indexOf("private void authenticateAndConnect"),
  );

  assert.match(sync, /requestedRevisions[\s\S]*requestedIds/);
  assert.match(
    applySync,
    /missingKeyAtCapturedRevision[\s\S]*removedRemotelyAtCapturedRevision \|\| missingKeyAtCapturedRevision/,
  );
  assert.match(applySync, /config\.profileRevision != currentRevision\) continue/);
  assert.match(
    client,
    /expectedSessionToken[\s\S]*profile\.keyFingerprint\.equals\(expectedSessionToken\)[\s\S]*profile\.crypto\.encryptMessage/,
  );
  assert.match(
    client,
    /synchronized \(profileStateLock\)[\s\S]*expectedSessionToken[\s\S]*profile\.crypto\.encryptMessage[\s\S]*send\(spaceId, envelope\)/,
  );
  assert.match(
    client,
    /sessionTokens\.get\(spaceId\)[\s\S]*profile\.keyFingerprint\.equals\(sessionToken\)[\s\S]*decryptMessage[\s\S]*listener\.onMessage\(spaceId, message, sessionToken\)/,
  );
  assert.match(
    manager,
    /handleMessage\(profileId, message, sessionToken\)[\s\S]*currentSession\(profileId, sessionToken\)/,
  );
});

test("Hermes chat schedules retention cleanup without resetting the relay checkpoint", async () => {
  const [history, service, manifest, activity] = await Promise.all([
    source("HermesChatHistoryStore.java"),
    source("HermesChatCleanupService.java"),
    readFile(new URL("../android/MyNotes/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
    source("HermesChatActivity.java"),
  ]);

  assert.match(history, /clearMessages[\s\S]*lastSequence/);
  assert.match(service, /setPeriodic\(/);
  assert.match(service, /loadAndCleanup/);
  assert.match(manifest, /HermesChatCleanupService/);
  assert.match(activity, /聊天缓存保留时间/);
  assert.match(activity, /清理当前聊天（本机和 Cloudflare）/);
});

test("encrypted chat images are cached, expandable, and explicitly saved through MediaStore", async () => {
  const [activity, imageCache] = await Promise.all([
    source("HermesChatActivity.java"),
    source("HermesChatImageCache.java"),
  ]);

  assert.match(imageCache, /hermes-chat-image-cache-v1/);
  assert.match(activity, /imageCache\.read\(descriptor\)/);
  assert.match(activity, /imageCache\.write\(descriptor, ciphertext\)/);
  assert.match(activity, /image\.setOnClickListener/);
  assert.match(activity, /showImagePreview/);
  assert.match(activity, /MediaStore\.Images\.Media\.EXTERNAL_CONTENT_URI/);
  assert.match(activity, /MediaStore\.MediaColumns\.RELATIVE_PATH/);
});

test("Android cloud cleanup is explicit and typing frames are deduplicated", async () => {
  const [activity, api, client] = await Promise.all([
    source("HermesChatActivity.java"),
    source("NotesApiClient.java"),
    source("HermesChatClient.java"),
  ]);

  assert.match(api, /purgeHermesChatCloudData/);
  assert.match(api, /api\/admin\/hermes-chat\/cleanup/);
  assert.match(activity, /本机和 Cloudflare/);
  assert.match(activity, /api\.purgeHermesChatCloudData\(spaceId\)/);
  assert.match(client, /lastTypingActive/);
  assert.match(client, /lastTypingActive\s*==\s*active/);
});

test("Android supports single and multi-select deletion after cloud confirmation", async () => {
  const [activity, api, history] = await Promise.all([
    source("HermesChatActivity.java"),
    source("NotesApiClient.java"),
    source("HermesChatHistoryStore.java"),
  ]);

  assert.match(activity, /setOnLongClickListener[\s\S]*showMessageActions/);
  assert.match(activity, /"选择消息"[\s\S]*toggleMessageSelection/);
  assert.match(activity, /for \(TextView selectable : rendered\.selectableTextViews\)[\s\S]*setTextIsSelectable\(!selecting\)/);
  assert.match(activity, /bindMessageTextView[\s\S]*setOnClickListener[\s\S]*toggleMessageSelection/);
  assert.match(activity, /已选择 " \+ selectedMessageIds\.size\(\) \+ " 条/);
  assert.match(activity, /confirmDeleteSelectedMessages/);
  assert.match(activity, /api\.deleteHermesChatMessages[\s\S]*targetHistory\.deleteMessages/);
  assert.match(activity, /targetCache\.retain\(snapshot\.messages\)/);
  assert.match(api, /api\/admin\/hermes-chat\/messages\/delete/);
  assert.match(history, /Snapshot deleteMessages\(Set<String> messageIds\)/);
});

test("Android refreshes the cookie-bound CSRF token before Hermes chat mutations", async () => {
  const api = await source("NotesApiClient.java");

  assert.match(
    api,
    /private void requireFreshAuthenticatedSession\(\) throws Exception \{[\s\S]*SessionResult session = restoreSession\(\);[\s\S]*!session\.authenticated \|\| csrfToken\.isEmpty\(\)/,
  );
  assert.equal(
    (api.match(/requireFreshAuthenticatedSession\(\);/g) || []).length,
    4,
  );
  assert.match(
    api,
    /JSONObject purgeHermesChatCloudData\(String spaceId\) throws Exception \{\s*requireFreshAuthenticatedSession\(\);/,
  );
  assert.match(
    api,
    /JSONObject deleteHermesChatMessages\([\s\S]*?\) throws Exception \{\s*requireFreshAuthenticatedSession\(\);/,
  );
  assert.match(
    api,
    /void uploadHermesChatAttachment\([\s\S]*?\) throws Exception \{\s*requireFreshAuthenticatedSession\(\);/,
  );
  assert.match(
    api,
    /HermesChatDirectDownloadTicket hermesChatDirectDownloadTicket\([\s\S]*?\) throws Exception \{\s*requireFreshAuthenticatedSession\(\);/,
  );
});

test("interactive prompt state is retained in the encrypted per-profile cache", async () => {
  const [history, crypto] = await Promise.all([
    source("HermesChatHistoryStore.java"),
    source("HermesChatCrypto.java"),
  ]);

  assert.match(history, /\.put\("interaction", cloneObject\(message\.interaction\)\)/);
  assert.match(history, /value\.optJSONObject\("interaction"\)/);
  assert.match(history, /cloneObject\(incoming\.interaction\)/);
  assert.match(crypto, /final JSONObject interaction/);
  assert.match(crypto, /validateInteraction\(interaction\)/);
});

test("Android coalesces replay persistence and avoids duplicate Activity snapshot writes", async () => {
  const [activity, manager, history] = await Promise.all([
    source("HermesChatActivity.java"),
    source("HermesChatConnectionManager.java"),
    source("HermesChatHistoryStore.java"),
  ]);

  assert.match(history, /Snapshot recordBatch\(List<HermesChatCrypto\.ChatMessage> incomingMessages\)/);
  assert.match(manager, /PERSISTENCE_BATCH_DELAY_MS = 40L/);
  assert.match(manager, /queueMessagePersistence\(session, message\)/);
  assert.match(manager, /session\.history\.recordBatch\(batch\)/);
  assert.doesNotMatch(activity, /private void persistMessage\(/);
  assert.doesNotMatch(activity, /targetHistory\.record\(message\)/);
});
