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
  assert.match(client, /ProfileState\(HermesChatCrypto crypto, long initialSequence\)/);
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
    /private JSONObject refreshDeviceToken\(\) throws Exception \{\s*synchronized \(SESSION_REFRESH_LOCK\) \{[\s\S]*request\("GET", "api\/auth\/me", null, null\)/,
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
