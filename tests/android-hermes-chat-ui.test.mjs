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
const cryptoPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatCrypto.java",
  import.meta.url,
);
const connectionManagerPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatConnectionManager.java",
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
const commandCatalogPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesCommandCatalog.java",
  import.meta.url,
);
const copyIconPath = new URL(
  "../android/MyNotes/app/src/main/res/drawable/ic_copy.xml",
  import.meta.url,
);
const commandIconPath = new URL(
  "../android/MyNotes/app/src/main/res/drawable/ic_command.xml",
  import.meta.url,
);
const fullscreenIconPath = new URL(
  "../android/MyNotes/app/src/main/res/drawable/ic_fullscreen.xml",
  import.meta.url,
);
const shareIconPath = new URL(
  "../android/MyNotes/app/src/main/res/drawable/ic_share.xml",
  import.meta.url,
);
const selectIconPath = new URL(
  "../android/MyNotes/app/src/main/res/drawable/ic_select.xml",
  import.meta.url,
);
const shareProviderPath = new URL(
  "../android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesShareFileProvider.java",
  import.meta.url,
);

test("Android renders every configured Hermes profile as an isolated conversation", async () => {
  const [chat, conversations, manifest] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(conversationsPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  assert.match(conversations, /api\.hermesChatProfiles\(\)/);
  assert.match(conversations, /HermesChatProfileStore/);
  assert.match(conversations, /loadCachedProfiles\(\)/);
  assert.match(conversations, /for \(Models\.HermesChatProfile profile : profiles\)/);
  assert.match(conversations, /putExtra\(HermesChatActivity\.EXTRA_PROFILE_ID, profile\.id\)/);
  assert.match(chat, /getStringExtra\(EXTRA_PROFILE_ID\)/);
  assert.match(chat, /loadRequestedProfile\(requestedLabel\)/);
  assert.doesNotMatch(chat, /api\.hermesChatProfiles\(\)/);
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
  assert.match(activity, /rendered\.message = new HermesChatCrypto\.ChatMessage[\s\S]*renderMessageContent\(rendered\)/);
});

test("Hermes message footers show the local send time instead of a sender label", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /DateTimeFormatter\.ofPattern\(\s*"yyyy-MM-dd HH:mm"/);
  assert.match(source, /formatMessageTime\(message\.sentAt\)/);
  assert.match(source, /formatMessageTime\(original\.sentAt\)/);
  assert.match(source, /meta\.setSingleLine\(true\)/);
  assert.match(source, /meta\.setMinWidth\(dp\(112\)\)/);
  assert.match(source, /footerParams = new LinearLayout\.LayoutParams\(-2, dp\(24\)\)/);
  assert.match(source, /footerParams\.gravity = Gravity\.END/);
  assert.doesNotMatch(source, /text\(outgoing \? "你" : "Hermes"/);
  assert.doesNotMatch(source, /message\.finalUpdate \? "Hermes"/);
});

test("Activity mirrors the manager's complete busy state without owning another timer", async () => {
  const [activity, manager] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(connectionManagerPath, "utf8"),
  ]);
  const onReady = activity.slice(
    activity.indexOf("public void onReady"),
    activity.indexOf("public void onConnecting"),
  );
  const onTyping = activity.slice(
    activity.indexOf("public void onTyping"),
    activity.indexOf("public void onDisconnected"),
  );
  const sendMessage = manager.slice(
    manager.indexOf("HermesChatCrypto.ChatMessage sendMessage"),
    manager.indexOf("String sendInteractionAction"),
  );
  const publishBusy = manager.slice(
    manager.indexOf("private void publishBusyState"),
    manager.indexOf("private void drainPendingEvents"),
  );

  assert.match(activity, /WS 已连接/);
  assert.match(activity, /WS 已断开/);
  assert.match(onReady, /webSocketReady = true;\s*restoreConversationStatus\(\)/);
  assert.match(onTyping, /setConversationBusy\(busy\)/);
  assert.match(activity, /conversationBusy \? "正在思考…" : "已加密"/);
  assert.doesNotMatch(activity, /expireAwaitingAgentResponse|AWAITING_RESPONSE_TIMEOUT_MS/);
  assert.match(sendMessage, /beginAwaitingAgentResponse\(session\)[\s\S]*client\.sendMessage/);
  assert.match(publishBusy, /target\.onTyping\(session\.isBusy\(\)\)/);
});

test("attachment sends keep the encryption key and WebSocket session aligned", async () => {
  const activity = await readFile(activityPath, "utf8");
  const start = activity.indexOf("private void sendAttachment");
  const sendAttachment = activity.slice(start, activity.indexOf("private byte[] readBounded", start));
  const uploadIndex = sendAttachment.indexOf("api.uploadHermesChatAttachment(");
  const generationGuardIndex = sendAttachment.indexOf("if (generation != profileGeneration");
  const sendIndex = sendAttachment.indexOf("targetConnection.sendMessage(");

  assert.match(
    sendAttachment,
    /profileSessionToken\(spaceId\)[\s\S]*encryptAttachment[\s\S]*runOnUiThread[\s\S]*isCurrentProfile\(spaceId, targetSessionToken\)[\s\S]*sendMessage\([\s\S]*targetSessionToken/,
  );
  assert.ok(uploadIndex >= 0 && uploadIndex < generationGuardIndex);
  assert.ok(generationGuardIndex < sendIndex);
  assert.match(
    activity,
    /private void startWithKey[\s\S]*long generation = \+\+profileGeneration/,
  );
});

test("long profile titles cannot cover the WebSocket status row", async () => {
  const source = await readFile(activityPath, "utf8");

  assert.match(source, /chatTitle\.setSingleLine\(true\)/);
  assert.match(source, /chatTitle\.setEllipsize\(TextUtils\.TruncateAt\.END\)/);
  assert.match(source, /status\.setSingleLine\(true\)/);
  assert.match(source, /status\.setEllipsize\(TextUtils\.TruncateAt\.END\)/);
  assert.match(source, /heading\.setMinimumHeight\(dp\(52\)\)/);
  assert.match(source, /"WS 已连接 · "/);
  assert.match(source, /restoreConversationStatus\(\)/);
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
  assert.match(chat, /getBooleanExtra\(EXTRA_DEMO_AWAITING, false\)[\s\S]*webSocketReady = true;[\s\S]*setConversationBusy\(true\)/);
  assert.match(conversations, /HermesChatActivity\.EXTRA_DEMO_AWAITING/);
  assert.match(main, /HermesChatActivity\.EXTRA_DEMO_AWAITING/);
});

test("incoming Hermes messages never open the keyboard and only preserve visible IME focus", async () => {
  const source = await readFile(activityPath, "utf8");
  const onResume = source.slice(
    source.indexOf("protected void onResume()"),
    source.indexOf("protected void onPause()"),
  );
  const onMessage = source.slice(
    source.indexOf("public void onMessage"),
    source.indexOf("public void onAcknowledged"),
  );
  const conditionalFocus = source.slice(
    source.indexOf("private void keepComposerFocusedIfImeVisible()"),
    source.indexOf("private void scrollMessagesToBottom"),
  );

  assert.match(onResume, /keepComposerFocusedIfImeVisible\(\)/);
  assert.doesNotMatch(onResume, /focusComposer\(true\)|\.show\(WindowInsets\.Type\.ime\(\)\)/);
  assert.match(onMessage, /appendMessage\(message\)[\s\S]*keepComposerFocusedIfImeVisible\(\)/);
  assert.doesNotMatch(onMessage, /focusComposer\(true\)|\.show\(WindowInsets\.Type\.ime\(\)\)/);
  assert.match(conditionalFocus, /getRootWindowInsets\(\)/);
  assert.match(conditionalFocus, /insets\.isVisible\(WindowInsets\.Type\.ime\(\)\)/);
  assert.match(conditionalFocus, /isVisible[\s\S]*composer\.requestFocus\(\)/);
  assert.doesNotMatch(conditionalFocus, /\.show\(WindowInsets\.Type\.ime\(\)\)/);
});

test("Hermes chat opens at the latest message and new messages auto-scroll without moving focus", async () => {
  const source = await readFile(activityPath, "utf8");
  const onResume = source.slice(
    source.indexOf("protected void onResume()"),
    source.indexOf("protected void onPause()"),
  );
  const renderCached = source.slice(
    source.indexOf("private void renderCachedMessages"),
    source.indexOf("private void toggleMessageSelection"),
  );
  const scrollHelper = source.slice(
    source.indexOf("private void scrollMessagesToBottom"),
    source.indexOf("private <T extends View> T applyInsets"),
  );

  assert.match(onResume, /scrollMessagesToBottom\(false\)/);
  assert.match(renderCached, /renderingCachedMessages = true[\s\S]*renderingCachedMessages = false/);
  assert.match(renderCached, /scrollMessagesToBottom\(false\)/);
  assert.match(source, /if \(!renderingCachedMessages\) \{[\s\S]*scrollMessagesToBottom\(true\)/);
  assert.match(scrollHelper, /messageScroll\.removeCallbacks\(applyPendingBottomScroll\)/);
  assert.match(source, /messageScroll\.smoothScrollTo\(0, bottom\)/);
  assert.match(source, /messageScroll\.scrollTo\(0, bottom\)/);
  assert.doesNotMatch(source, /fullScroll\(View\.FOCUS_DOWN\)/);
});

test("Android keeps full encrypted history while rendering bounded chat and search windows", async () => {
  const source = await readFile(activityPath, "utf8");
  const cachedRender = source.slice(
    source.indexOf("private void renderCachedMessages"),
    source.indexOf("private void toggleMessageSelection"),
  );
  const search = source.slice(
    source.indexOf("private void refreshMessageSearch"),
    source.indexOf("private void updateMessageSearchControls"),
  );

  assert.match(source, /MESSAGE_WINDOW_SIZE = 120/);
  assert.match(source, /SEARCH_MESSAGE_WINDOW_SIZE = 60/);
  assert.match(source, /cachedMessageOrder\.addAll\(snapshot\.messages\)/);
  assert.match(cachedRender, /cachedMessageOrder\.size\(\) - visibleMessageLimit/);
  assert.match(cachedRender, /visibleMessageLimit \+ MESSAGE_WINDOW_SIZE/);
  assert.match(cachedRender, /加载更早的本地消息/);
  assert.match(source, /trimRenderedMessagesToWindow\(\)/);
  assert.match(search, /for \(HermesChatCrypto\.ChatMessage message : cachedMessageOrder\)/);
  assert.match(search, /SEARCH_MESSAGE_WINDOW_SIZE \/ 2/);
  assert.match(search, /start \+ SEARCH_MESSAGE_WINDOW_SIZE/);
  assert.doesNotMatch(cachedRender, /for \(HermesChatCrypto\.ChatMessage message : snapshot\.messages\)/);
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

test("Hermes message actions move to a long-press sheet while code blocks keep copy", async () => {
  const [activity, markdown, copyIcon, shareIcon, selectIcon] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(markdownPath, "utf8"),
    readFile(copyIconPath, "utf8"),
    readFile(shareIconPath, "utf8"),
    readFile(selectIconPath, "utf8"),
  ]);

  assert.match(copyIcon, /android:pathData=/);
  assert.match(shareIcon, /android:pathData=/);
  assert.match(selectIcon, /android:pathData=/);
  assert.doesNotMatch(activity, /复制整条消息文字/);
  assert.doesNotMatch(activity, /final ImageButton messageCopy/);
  assert.match(activity, /bubble\.setOnLongClickListener[\s\S]*showMessageActions\(rendered\)/);
  assert.match(activity, /messageActionRow\([\s\S]*R\.drawable\.ic_copy,[\s\S]*"复制文字"/);
  assert.match(activity, /messageActionRow\([\s\S]*R\.drawable\.ic_share,[\s\S]*"分享文字"/);
  assert.match(activity, /shareMessageText\(rendered\)/);
  assert.match(activity, /R\.drawable\.ic_select,[\s\S]*"选择消息"/);
  assert.match(activity, /R\.drawable\.ic_trash,[\s\S]*"删除消息"/);
  assert.match(activity, /R\.drawable\.ic_copy, "复制此代码块"/);
  assert.match(activity, /copyText\("代码", block\.text, "代码块已复制"\)/);
  assert.match(activity, /HorizontalScrollView/);
  assert.match(markdown, /static List<Block> parseBlocks/);
  assert.match(markdown, /new Block\(true, language, code\)/);
});

test("long-press message actions route attachment share, save, and playback by type", async () => {
  const [activity, provider] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(shareProviderPath, "utf8"),
  ]);
  const sheet = activity.slice(
    activity.indexOf("private void showMessageActions"),
    activity.indexOf("private View messageActionRow"),
  );

  assert.match(sheet, /shareMessageAttachments\(rendered\)/);
  assert.match(sheet, /saveImageAttachment\(descriptor\)/);
  assert.match(sheet, /requestSaveAttachment\(descriptor\)/);
  assert.match(sheet, /playAttachment\(descriptor, resolved\)/);
  assert.match(sheet, /confirmDeleteMessage\(rendered\)/);
  assert.match(activity, /Intent\.EXTRA_TEXT, text/);
  assert.match(activity, /Intent\.ACTION_SEND_MULTIPLE/);
  assert.match(activity, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(provider, /createAttachmentFile/);
  assert.match(provider, /HermesChatAttachmentPolicy\.resolve/);
  assert.match(provider, /ParcelFileDescriptor\.MODE_READ_ONLY/);
});

test("Hermes chat searches the complete ordered local cache without a server query", async () => {
  const activity = await readFile(activityPath, "utf8");
  const search = activity.slice(
    activity.indexOf("private void refreshMessageSearch()"),
    activity.indexOf("private void navigateMessageSearch"),
  );

  assert.match(activity, /R\.drawable\.ic_search, "搜索本地聊天消息"/);
  assert.match(search, /for \(HermesChatCrypto\.ChatMessage message : cachedMessageOrder\)/);
  assert.match(search, /message\.text/);
  assert.match(search, /toLowerCase\(Locale\.ROOT\)\.contains\(query\)/);
  assert.doesNotMatch(search, /api\.|connection\.|hermesChat/);
  assert.match(activity, /smoothScrollTo\(0, Math\.max\(0, rendered\.row\.getTop\(\) - dp\(12\)\)\)/);
  assert.match(activity, /isMessageSearchActive\(\) \|\| !composer\.isAttachedToWindow\(\)/);
});

test("composer attachment and command tools share centered 48dp controls", async () => {
  const [activity, commandIcon] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(commandIconPath, "utf8"),
  ]);
  const compose = activity.slice(
    activity.indexOf("LinearLayout compose = horizontal(Gravity.BOTTOM)"),
    activity.indexOf("composer = new EditText", activity.indexOf("LinearLayout compose = horizontal(Gravity.BOTTOM)")),
  );

  assert.match(commandIcon, /android:width="24dp"/);
  assert.match(commandIcon, /android:pathData=/);
  assert.match(compose, /LinearLayout inputTools = horizontal\(Gravity\.CENTER_VERTICAL\)/);
  assert.match(compose, /inputTools\.setBaselineAligned\(false\)/);
  assert.match(compose, /attachment\.setBackground\(rounded\(R\.color\.surface_tonal, 16\)\)/);
  assert.match(compose, /ImageButton commandButton = iconButton\(R\.drawable\.ic_command/);
  assert.match(compose, /commandButtonParams\.setMarginStart\(dp\(8\)\)/);
  assert.match(compose, /compose\.addView\(inputTools, new LinearLayout\.LayoutParams\(-2, dp\(48\)\)\)/);
  assert.equal((compose.match(/new LinearLayout\.LayoutParams\(dp\(48\), dp\(48\)\)/g) || []).length, 2);
  assert.doesNotMatch(compose, /TextView commandButton/);
});

test("chat images keep a visible expand action and a font-safe preview toolbar", async () => {
  const [activity, fullscreenIcon] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(fullscreenIconPath, "utf8"),
  ]);
  const thumbnail = activity.slice(
    activity.indexOf("private void addAttachmentPreview"),
    activity.indexOf("private void addFileCard"),
  );
  const preview = activity.slice(
    activity.indexOf("private void showImagePreview(JSONObject"),
    activity.indexOf("private void shareImage"),
  );

  assert.match(fullscreenIcon, /android:width="24dp"/);
  assert.match(thumbnail, /FrameLayout preview = new FrameLayout\(this\)/);
  assert.match(thumbnail, /R\.drawable\.ic_fullscreen, "放大聊天图片"/);
  assert.match(thumbnail, /dp\(48\),\s*dp\(48\),\s*Gravity\.END \| Gravity\.BOTTOM/);
  assert.match(thumbnail, /expandParams\.setMargins\(0, 0, dp\(8\), dp\(8\)\)/);
  assert.match(preview, /imageParams\.setMargins\(0, dp\(64\), 0, 0\)/);
  assert.match(preview, /title\.setSingleLine\(true\)/);
  assert.match(preview, /imagePreviewActionButton\("关闭", "关闭图片预览"\)/);
  assert.match(preview, /imagePreviewActionButton\("分享", "分享图片"\)/);
  assert.match(preview, /imagePreviewActionButton\("保存相册", "保存图片到相册"\)/);
  assert.match(preview, /new FrameLayout\.LayoutParams\(-1, dp\(64\), Gravity\.TOP\)/);
  assert.doesNotMatch(preview, /new Button\(this\)/);
});

test("Hermes chat offers official messaging command autocomplete and guided quick actions", async () => {
  const [activity, catalog] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(commandCatalogPath, "utf8"),
  ]);

  assert.match(activity, /updateCommandSuggestions\(s\.toString\(\)\)/);
  assert.match(activity, /HermesCommandCatalog\.suggestions\(value, 6\)/);
  assert.match(activity, /打开 Hermes 快捷指令/);
  assert.match(activity, /选择后只会填入输入框，不会自动执行/);
  assert.match(activity, /insertCommand\(action\.commandWith\(value\), command\.caution\)/);
  assert.doesNotMatch(
    activity.slice(
      activity.indexOf("private void insertCommand"),
      activity.indexOf("private void sendCurrentMessage"),
    ),
    /sendMessage\(/,
  );

  for (const command of [
    "help", "commands", "status", "model", "sessions", "stop", "new", "reset",
    "background", "queue", "steer", "goal", "context", "usage", "egress",
    "debug", "update", "restart",
  ]) {
    assert.match(catalog, new RegExp("command\\(\\\"" + command + "\\\""));
  }
  assert.match(catalog, /provider:model 或模型别名/);
  assert.match(activity, /当前 NAS 版本[\s\S]*以 \/commands 的回复为准/);
  for (const cliOnly of ["quit", "clear", "tools", "browser", "config", "plugins"]) {
    assert.doesNotMatch(catalog, new RegExp("command\\(\\\"" + cliOnly + "\\\""));
  }
});

test("Hermes conversation list shows persistent per-profile unread badges", async () => {
  const source = await readFile(conversationsPath, "utf8");

  assert.match(source, /implements HermesChatConnectionManager\.UnreadListener/);
  assert.match(source, /connection\.unreadCount\(profile\.id\)/);
  assert.match(source, /unreadCount > 99 \? "99\+"/);
  assert.match(source, /onUnreadChanged\(String profileId, int unreadCount\)/);
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
  for (const icon of [
    "ic_file_image", "ic_file_audio", "ic_file_video", "ic_file_document",
    "ic_file_office", "ic_file_archive", "ic_file_book", "ic_file_package",
  ]) {
    assert.match(policy, new RegExp(`R\\.drawable\\.${icon}`));
    const vector = await readFile(
      new URL(`../android/MyNotes/app/src/main/res/drawable/${icon}.xml`, import.meta.url),
      "utf8",
    );
    assert.match(vector, /android:width="24dp"/);
    assert.match(vector, /android:pathData=/);
  }
  assert.match(activity, /typeIcon\.setContentDescription\(category \+ "附件图标"\)/);
  assert.match(activity, /summary\.addView\(iconHolder/);
  assert.match(activity, /labelsParams\.setMarginStart\(dp\(12\)\)/);
  assert.match(activity, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(activity, /saveAttachmentToUri/);
  assert.match(activity, /new MediaPlayer\(\)/);
  assert.match(activity, /new VideoView\(this\)/);
  assert.match(activity, /hermes-chat-playback/);
  assert.match(activity, /deletePlaybackFile/);
});

test("decrypted chat images share through a temporary read-only content URI", async () => {
  const [activity, provider, manifest] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(shareProviderPath, "utf8"),
    readFile(manifestPath, "utf8"),
  ]);

  assert.match(activity, /imagePreviewActionButton\("分享", "分享图片"\)/);
  assert.match(activity, /new Intent\(Intent\.ACTION_SEND\)/);
  assert.match(activity, /Intent\.EXTRA_STREAM, shareUri/);
  assert.match(activity, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(activity, /ClipData\.newUri/);
  assert.match(
    activity,
    /SHARE_CLEANUP_HANDLER\.postDelayed\(readyFile::delete, SHARE_FILE_LIFETIME_MS\)/,
  );
  assert.match(provider, /getCacheDir\(\), DIRECTORY/);
  assert.match(provider, /ParcelFileDescriptor\.MODE_READ_ONLY/);
  assert.match(provider, /if \(!"r"\.equals\(mode\)\)/);
  assert.match(provider, /file\.lastModified\(\) < cutoffMillis/);
  assert.match(
    manifest,
    /android:name="\.HermesShareFileProvider"[\s\S]*android:exported="false"[\s\S]*android:grantUriPermissions="true"/,
  );
});

test("Hermes official interactive prompts render encrypted accessible action buttons", async () => {
  const [activity, client, crypto, manager] = await Promise.all([
    readFile(activityPath, "utf8"),
    readFile(clientPath, "utf8"),
    readFile(cryptoPath, "utf8"),
    readFile(connectionManagerPath, "utf8"),
  ]);

  assert.match(crypto, /payload\.optJSONObject\("interaction"\)/);
  assert.match(crypto, /encryptInteractionResponse/);
  assert.match(crypto, /only the agent|仅 Hermes 可以发送交互操作/);
  assert.match(client, /\.put\("type", "action"\)/);
  assert.match(client, /\.put\("message", message\)/);
  assert.match(client, /!frame\.optBoolean\("durable", true\)/);
  assert.match(
    manager,
    /sendInteractionAction\(profileId, promptId, optionId, actionId\)/,
  );
  assert.match(activity, /private void addInteractionCard/);
  assert.match(activity, /button\.setMinHeight\(dp\(48\)\)/);
  assert.match(activity, /button\.setText\(\(selected \? "✓ " : ""\) \+ label\)/);
  assert.match(activity, /"danger"\.equals\(style\)/);
  assert.match(activity, /"warning"\.equals\(style\)/);
  assert.match(activity, /pendingInteractionPromptIds\.contains\(promptId\)/);
  assert.match(activity, /INTERACTION_RESULT_TIMEOUT_MS/);
  assert.doesNotMatch(activity, /sendMessage\([^\n]*optionId/);
});
