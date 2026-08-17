import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const activityPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatActivity.java",
  import.meta.url,
);
const conversationsPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesConversationsActivity.java",
  import.meta.url,
);
const mainActivityPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/MainActivity.java",
  import.meta.url,
);
const manifestPath = new URL(
  "../android/MyNotes/app/src/main/AndroidManifest.xml",
  import.meta.url,
);
const clientPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatClient.java",
  import.meta.url,
);

test("Android renders every configured Hermes profile as an isolated conversation", async () => {
  const [chat, conversations, manifest] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(conversationsPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  assert.match(conversations, /api\.hermesChatProfiles\(\)/);
  assert.match(conversations, /for \(Models\.HermesChatProfile profile : profiles\)/);
  assert.match(conversations, /putExtra\(HermesChatActivity\.EXTRA_PROFILE_ID, profile\.id\)/);
  assert.match(chat, /getStringExtra\(EXTRA_PROFILE_ID\)/);
  assert.match(chat, /profile\.id\.equals\(requestedProfileId\)/);
  assert.doesNotMatch(chat, /selectProfile\(profiles\.get\(0\)\)/);
  assert.match(manifest, /HermesConversationsActivity/);
});

test("Hermes conversation list uses local encrypted previews without opening sockets", async () => {
  const source = await readFile(conversationsPath, "utf8");

  assert.match(source, /new HermesChatHistoryStore\(/);
  assert.match(source, /loadAndCleanup\(/);
  assert.match(source, /搜索聊天对象/);
  assert.match(source, /端到端加密/);
  assert.doesNotMatch(source, /HermesChatClient|hermesChatTicket/);
});

test("main bottom navigation opens Hermes conversations while folders remain reachable", async () => {
  const source = await readFile(mainActivityPath, "utf8");
  const start = source.indexOf("private LinearLayout buildBottomNavigation()");
  const end = source.indexOf("private void showCreateMenu", start);
  const navigation = source.slice(start, end);

  assert.match(navigation, /navigationButton\("Hermes", R\.drawable\.ic_chat, false\)/);
  assert.match(navigation, /openHermesConversations\(\)/);
  assert.doesNotMatch(navigation, /"文件夹"/);
  assert.match(source, /shortcutButton\("文件夹", R\.drawable\.ic_folder\)/);
});

test("selected chat images wait for an explicit send and keep the caption", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /onActivityResult[\s\S]*stageImage\(uri\)/);
  assert.match(source, /sendCurrentMessage[\s\S]*pendingImageUri != null[\s\S]*sendImage/);
  assert.match(source, /String caption = composer\.getText\(\)\.toString\(\)\.trim\(\)/);
  assert.match(source, /点击发送后才会上传/);
});

test("Hermes chat composer accounts for the on-screen keyboard", async () => {
  const [source, manifest] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  assert.match(source, /WindowInsets\.Type\.ime\(\)/);
  assert.match(source, /Math\.max\(bars\.bottom, ime\.bottom\)/);
  assert.match(manifest, /HermesChatActivity[\s\S]*windowSoftInputMode="adjustResize"/);
});

test("Hermes stream edits update an existing Android message bubble", async () => {
  const [activity, client] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(clientPath, "utf8"),
  ]);

  assert.match(client, /"edit"\.equals\(type\)/);
  assert.match(client, /replaceSequence != frame\.getLong\("targetSeq"\)/);
  assert.match(activity, /renderedMessagesBySequence/);
  assert.match(activity, /replaceMessage\(message\)/);
  assert.match(activity, /body\.setText\(message\.text\)/);
});

test("Hermes message footers show the local send time instead of a sender label", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /DateTimeFormatter\.ofPattern\(\s*"yyyy-MM-dd HH:mm"/);
  assert.match(source, /formatMessageTime\(message\.sentAt\)/);
  assert.match(source, /formatMessageTime\(rendered\.sentAt\)/);
  assert.doesNotMatch(source, /text\(outgoing \? "你" : "Hermes"/);
  assert.doesNotMatch(source, /message\.finalUpdate \? "Hermes"/);
});
