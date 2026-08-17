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
const attachmentPolicyPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatAttachmentPolicy.java",
  import.meta.url,
);
const markdownPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatMarkdown.java",
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

test("Hermes conversation list uses local encrypted previews without search or sockets", async () => {
  const source = await readFile(conversationsPath, "utf8");

  assert.match(source, /new HermesChatHistoryStore\(/);
  assert.match(source, /loadAndCleanup\(/);
  assert.match(source, /端到端加密/);
  assert.doesNotMatch(source, /搜索聊天对象|TextWatcher|filterProfiles/);
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

test("selected chat attachments wait for an explicit send and keep the caption", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /onActivityResult[\s\S]*stageAttachment\(uri\)/);
  assert.match(source, /sendCurrentMessage[\s\S]*pendingAttachmentUri != null[\s\S]*sendAttachment/);
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
  assert.match(activity, /setMessageBody\(body, message\.text/);
});

test("Hermes message footers show the local send time instead of a sender label", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /DateTimeFormatter\.ofPattern\(\s*"yyyy-MM-dd HH:mm"/);
  assert.match(source, /formatMessageTime\(message\.sentAt\)/);
  assert.match(source, /formatMessageTime\(original\.sentAt\)/);
  assert.doesNotMatch(source, /text\(outgoing \? "你" : "Hermes"/);
  assert.doesNotMatch(source, /message\.finalUpdate \? "Hermes"/);
});

test("every profile shows WebSocket and awaiting-response status immediately after send", async () => {
  const source = await readFile(activityPath, "utf8");
  const onMessage = source.slice(
    source.indexOf("public void onMessage"),
    source.indexOf("public void onAcknowledged"),
  );
  const onTyping = source.slice(
    source.indexOf("public void onTyping"),
    source.indexOf("public void onDisconnected"),
  );
  const sendText = source.slice(
    source.indexOf("private void sendText()"),
    source.indexOf("private void chooseAttachment()"),
  );
  const sendAttachment = source.slice(
    source.indexOf("private void sendAttachment(Uri uri)"),
    source.indexOf("private void renderCachedMessages"),
  );

  assert.match(source, /WS 已连接/);
  assert.match(source, /WS 已断开/);
  assert.match(sendText, /connection\.sendMessage[\s\S]*markAwaitingAgentResponse\(\)/);
  assert.match(sendAttachment, /targetConnection\.sendMessage[\s\S]*markAwaitingAgentResponse\(\)/);
  assert.match(onMessage, /"agent"\.equals\(message\.sender\)[\s\S]*clearAwaitingAgentResponse\(\)/);
  assert.doesNotMatch(onTyping, /else clearAwaitingAgentResponse\(\)/);
  assert.match(source, /showConnectionAwareStatus\("正在思考…"\)/);
});

test("long profile titles cannot cover the WebSocket status row", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /chatTitle\.setSingleLine\(true\)/);
  assert.match(source, /chatTitle\.setEllipsize\(TextUtils\.TruncateAt\.END\)/);
  assert.match(source, /status\.setSingleLine\(true\)/);
  assert.match(source, /status\.setEllipsize\(TextUtils\.TruncateAt\.END\)/);
  assert.match(source, /heading\.setMinimumHeight\(dp\(52\)\)/);
  assert.match(source, /"WS 已连接 · "/);
  assert.match(source, /showConnectionAwareStatus\("已加密"\)/);
  assert.doesNotMatch(source, /new LinearLayout\.LayoutParams\(0, dp\(52\), 1\)/);
  assert.doesNotMatch(source, /"WebSocket 已连接 · "/);
});

test("debug demo can render the real awaiting status through normal navigation", async () => {
  const [chat, conversations, main] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(conversationsPath, "utf8"),
    readFile(mainActivityPath, "utf8"),
  ]);

  assert.match(chat, /EXTRA_DEMO_AWAITING/);
  assert.match(chat, /getBooleanExtra\(EXTRA_DEMO_AWAITING, false\)[\s\S]*webSocketReady = true;[\s\S]*markAwaitingAgentResponse\(\)/);
  assert.match(conversations, /HermesChatActivity\.EXTRA_DEMO_AWAITING/);
  assert.match(main, /HermesChatActivity\.EXTRA_DEMO_AWAITING/);
});

test("chat composer keeps focus on entry and after incoming Hermes messages", async () => {
  const source = await readFile(activityPath, "utf8");
  const onResume = source.slice(
    source.indexOf("protected void onResume()"),
    source.indexOf("protected void onPause()"),
  );
  const onMessage = source.slice(
    source.indexOf("public void onMessage"),
    source.indexOf("public void onAcknowledged"),
  );

  assert.match(onResume, /focusComposer\(true\)/);
  assert.match(onMessage, /appendMessage\(message\)[\s\S]*focusComposer\(true\)/);
  assert.match(source, /composer\.requestFocus\(\)/);
  assert.match(source, /controller\.show\(WindowInsets\.Type\.ime\(\)\)/);
});

test("Hermes chat renders Telegram-style Markdown and fenced code blocks", async () => {
  const [activity, markdown] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(markdownPath, "utf8"),
  ]);

  assert.match(activity, /HermesChatMarkdown\.render\(/);
  assert.match(markdown, /markdown\.indexOf\("```"/);
  assert.match(markdown, /TypefaceSpan\("monospace"\)/);
  assert.match(markdown, /BackgroundColorSpan/);
  assert.match(markdown, /StrikethroughSpan/);
  assert.match(markdown, /headingLevel/);
});

test("encrypted attachments cover requested formats, SAF saving, and media playback", async () => {
  const [activity, policy] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(attachmentPolicyPath, "utf8"),
  ]);

  for (const extension of [
    "png", "svg", "mp3", "opus", "mp4", "mkv", "pdf", "txt", "md", "json",
    "docx", "xlsx", "pptx", "zip", "rar", "7z", "epub", "apk", "ipa",
  ]) {
    assert.match(policy, new RegExp(`add\\(extensions, "${extension}"`));
  }
  assert.match(activity, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(activity, /saveAttachmentToUri/);
  assert.match(activity, /new MediaPlayer\(\)/);
  assert.match(activity, /new VideoView\(this\)/);
  assert.match(activity, /hermes-chat-playback/);
  assert.match(activity, /deletePlaybackFile/);
});
