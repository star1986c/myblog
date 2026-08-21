import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const base = "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/";
const source = (name) => readFile(new URL(`${base}${name}`, import.meta.url), "utf8");

test("Android asks for notification permission when the user opens Hermes conversations", async () => {
  const [conversations, manifest] = await Promise.all([
    source("HermesConversationsActivity.java"),
    readFile(new URL("../android/MyNotes/app/src/main/AndroidManifest.xml", import.meta.url), "utf8"),
  ]);

  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(conversations, /REQUEST_NOTIFICATION_PERMISSION/);
  assert.match(conversations, /requestHermesNotificationPermission\(\)/);
  assert.match(
    conversations,
    /requestPermissions\(\s*new String\[\] \{ Manifest\.permission\.POST_NOTIFICATIONS \}/,
  );
  assert.match(conversations, /ACTION_APP_NOTIFICATION_SETTINGS/);
});

test("background Hermes agent messages create private profile-routed notifications", async () => {
  const [manager, notifications] = await Promise.all([
    source("HermesChatConnectionManager.java"),
    source("HermesChatNotifications.java"),
  ]);

  assert.match(notifications, /NotificationManager\.IMPORTANCE_HIGH/);
  assert.match(notifications, /checkSelfPermission\(Manifest\.permission\.POST_NOTIFICATIONS\)/);
  assert.match(notifications, /new Intent\(context, HermesChatActivity\.class\)/);
  assert.match(notifications, /putExtra\(HermesChatActivity\.EXTRA_PROFILE_ID, profileId\)/);
  assert.match(notifications, /putExtra\(HermesChatActivity\.EXTRA_PROFILE_LABEL, profileLabel\)/);
  assert.match(notifications, /setVisibility\(Notification\.VISIBILITY_PRIVATE\)/);
  assert.match(notifications, /setPublicVersion\(/);
  assert.match(notifications, /setNumber\(unreadCount\)/);
  assert.match(notifications, /setOnlyAlertOnce\(true\)/);
  assert.doesNotMatch(notifications, /message\.text|messageText/);

  const handleMessage = manager.slice(
    manager.indexOf("private void handleMessage("),
    manager.indexOf("private void handleAcknowledged("),
  );
  assert.match(
    handleMessage,
    /!session\.visible && message\.replaceSequence == 0[\s\S]*notifications\.showMessage\([\s\S]*notifyUnread/,
  );
  assert.match(manager, /String profileLabel/);
  assert.match(manager, /notifications\.cancel\(profileId\)/);
});

test("opening a Hermes notification can address any cached profile without a second socket", async () => {
  const [activity, manager] = await Promise.all([
    source("HermesChatActivity.java"),
    source("HermesChatConnectionManager.java"),
  ]);

  assert.match(
    activity,
    /connection\.attach\(\s*spaceId,\s*selectedProfile\.label,\s*encodedKey/,
  );
  assert.match(manager, /void attach\(\s*String profileId,\s*String profileLabel,/);
  assert.match(manager, /existing\.profileLabel = config\.profileLabel/);
  const handleMessage = manager.slice(
    manager.indexOf("private void handleMessage("),
    manager.indexOf("private void handleAcknowledged("),
  );
  assert.doesNotMatch(handleMessage, /new HermesChatClient\(/);
});
