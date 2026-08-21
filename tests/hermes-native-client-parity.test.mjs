import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const contract = JSON.parse(await readFile(
  new URL("docs/hermes-native-client-capabilities.json", root),
  "utf8",
));

const sources = {
  android: await readSources([
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatActivity.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesConversationsActivity.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatClient.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatConnectionManager.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatConnectionService.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatCrypto.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatHistoryStore.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatAttachmentPolicy.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatPrivateAttachmentCache.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/NotesApiClient.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesCommandCatalog.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/HermesChatUnreadStore.java",
    "android/MyNotes/app/src/main/java/io/qzz/superstar1014/mynotes/SecureSessionStore.java",
    "android/MyNotes/app/src/main/AndroidManifest.xml",
  ]),
  macos: await readSources([
    "macos/AIBuildNotes/Sources/AIBuildNotes/AIBuildNotesApp.swift",
    "macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatViews.swift",
    "macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatMessageViews.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatStore.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatClient.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatCrypto.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatHistoryStore.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatAttachmentCache.swift",
    "macos/AIBuildNotes/Sources/NotesCore/NotesAPIClient.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatKeychain.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesChatAttachmentPolicy.swift",
    "macos/AIBuildNotes/Sources/NotesCore/HermesCommandCatalog.swift",
    "macos/AIBuildNotes/Tests/NotesCoreTests/HermesChatCryptoTests.swift",
  ]),
  server: await readSources([
    "src/hermes-chat-hub.js",
    "src/hermes-chat-room.js",
    "src/hermes-chat-direct-upload.js",
    "src/worker.js",
  ]),
};

const markers = {
  dynamic_profiles: {
    android: [/hermesChatProfiles\(\)/, /for \(Models\.HermesChatProfile profile/],
    macos: [/hermesChatProfiles\(\)/, /ForEach\(store\.profiles\)/],
  },
  multiplex_websocket: {
    android: [/X-Hermes-Mode/, /multiplex/],
    macos: [/X-Hermes-Mode/, /HermesChatMultiplexTicket/],
  },
  concurrent_devices: {
    android: [/HermesChatConnectionManager\.get/, /remoteMessaging/],
    macos: [/HermesChatStore\(api: api\)/, /\.task\(id: store\.user/],
    server: [/getWebSockets\("role:client"\)/, /does not close|native-client WebSockets/i],
  },
  cross_device_sync: {
    android: [/onMessage/, /persistMessage/],
    macos: [/case \.message/, /history\.record/],
    server: [/handleMultiplexClientFrame[\s\S]*broadcastToClientHubs/, /deliver\(spaceIdValue, frame\)/],
  },
  end_to_end_encryption: {
    android: [/AES\/GCM\/NoPadding/, /encryptMessage/],
    macos: [/AES\.GCM/, /encryptMessageEnvelope/],
  },
  secure_profile_keys: {
    android: [/loadHermesChatKey/, /AndroidKeyStore/],
    macos: [/HermesChatKeychain/, /kSecClassGenericPassword/],
  },
  encrypted_local_history: {
    android: [/encryptLocalSnapshot/, /noBackupFilesDir|getNoBackupFilesDir/],
    macos: [/encryptLocalSnapshot/, /HermesChatHistory-v1/],
  },
  incremental_resume: {
    android: [/afterSeq/, /lastSequence/],
    macos: [/"afterSeq"/, /lastSequence/],
  },
  streaming_edits: {
    android: [/"edit"\.equals\(type\)/, /replaceMessage/],
    macos: [/case "message", "edit"/, /replaceSequence/],
  },
  typing_and_awaiting: {
    android: [/正在思考/, /onTyping/],
    macos: [/正在思考/, /typingProfiles/],
  },
  unread_counts: {
    android: [/HermesChatUnreadStore/, /unread/],
    macos: [/unreadByProfile/, /totalUnread/],
  },
  local_message_search: {
    android: [/搜索本地消息/, /messageSearchMatches/],
    macos: [/搜索本机缓存/, /visibleMessages/],
  },
  markdown_and_code: {
    android: [/HermesChatMarkdown/, /codeCopyButtons/],
    macos: [/HermesMarkdownParser/, /HermesCodeBlock/],
  },
  slash_commands: {
    android: [/HermesCommandCatalog/, /commandSuggestions/],
    macos: [/HermesCommandCatalog/, /HermesCommandPalette/],
  },
  interactive_actions: {
    android: [/sendInteractionAction/, /optJSONArray\("options"\)/],
    macos: [/sendInteractionAction/, /HermesInteractionView/, /interaction\.isPending\(at:/],
  },
  attachment_types: {
    android: [/Category\.IMAGE/, /Category\.AUDIO/, /Category\.VIDEO/, /Category\.ARCHIVE/],
    macos: [/case image/, /case audio/, /case video/, /case archive/],
  },
  attachment_icons: {
    android: [/iconResource/, /ic_file_office/],
    macos: [/systemImage\(/, /tablecells/],
  },
  image_preview_share_save: {
    android: [/showImagePreview/, /shareImage/, /saveImageToGallery/],
    macos: [/HermesImagePreview/, /shareAttachment/, /saveAttachment/],
  },
  media_playback: {
    android: [/openAudioPlayer|showAudioPlayer/, /openVideoPlayer|showVideoPlayer/],
    macos: [/HermesMediaPreview/, /HermesAVPlayerView/, /AVPlayerView/],
  },
  document_open_share_save: {
    android: [/saveAttachment/, /shareMessageAttachments/],
    macos: [/NSWorkspace\.shared\.open/, /saveData/, /NSSharingServicePicker/],
  },
  agent_large_private_attachments: {
    android: [/PRIVATE_ATTACHMENT_STORAGE/, /downloadHermesChatDirectAttachment/, /MessageDigest\.getInstance\("SHA-256"\)/],
    macos: [/privateAttachmentStorage/, /downloadHermesChatDirectAttachment/, /validatePrivateFile/],
    server: [/createHermesChatDirectUploadTicket/, /x-amz-checksum-sha256/, /If-None-Match/],
  },
  message_actions: {
    android: [/confirmDeleteSelectedMessages/, /ACTION_PROCESS_TEXT|shareTextMessage|shareMessage/],
    macos: [/选择多条消息/, /复制文字/, /分享文字/, /deleteMessages/],
    server: [/messages\/delete/, /deleteHermesChatAttachmentsById/],
  },
  retention_cleanup: {
    android: [/loadAndCleanup/, /purgeHermesChatCloudData/],
    macos: [/loadAndCleanup/, /purgeProfile/, /attachmentCache\.cleanup/],
    server: [/hermes-chat\/cleanup/, /deleteHermesChatAttachments/],
  },
  persistent_process_connection: {
    android: [/HermesChatConnectionService/, /startIfConfigured/],
    macos: [/hermesStore\.start\(\)/, /setApplicationActive/],
  },
};

test("Hermes native-client capability contract requires Android and macOS parity", () => {
  assert.equal(contract.schemaVersion, 1);
  assert.deepEqual(contract.clients, ["android", "macos"]);
  assert.equal(new Set(contract.capabilities.map(({ id }) => id)).size, contract.capabilities.length);
  assert.deepEqual(
    contract.capabilities.map(({ id }) => id).sort(),
    Object.keys(markers).sort(),
  );

  for (const capability of contract.capabilities) {
    assert.deepEqual(capability.requiredOn, ["android", "macos"], capability.id);
    for (const client of capability.requiredOn) {
      for (const pattern of markers[capability.id][client]) {
        assert.match(sources[client], pattern, `${capability.id} is missing from ${client}`);
      }
    }
    if (capability.serverRequired) {
      assert.ok(markers[capability.id].server, `${capability.id} needs server markers`);
      for (const pattern of markers[capability.id].server) {
        assert.match(sources.server, pattern, `${capability.id} is missing from server`);
      }
    }
  }
});

test("macOS Hermes media playback avoids the crashing SwiftUI AVKit bridge", async () => {
  const source = await readFile(
    new URL("macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatMessageViews.swift", root),
    "utf8",
  );

  assert.doesNotMatch(source, /\bVideoPlayer\s*\(/);
  assert.match(source, /HermesAVPlayerView\(player: playback\.player\)/);
  assert.match(source, /static func dismantleNSView/);
  assert.match(source, /view\.player = nil/);
  assert.match(source, /player\.replaceCurrentItem\(with: nil\)/);
});

test("macOS Hermes image preview fits the full image before applying zoom", async () => {
  const source = await readFile(
    new URL("macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatMessageViews.swift", root),
    "utf8",
  );
  const previewStart = source.indexOf("private struct HermesImagePreview");
  const previewEnd = source.indexOf("private struct HermesMediaPreview");
  const preview = source.slice(previewStart, previewEnd);

  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  assert.match(preview, /GeometryReader/);
  assert.match(preview, /fittedImageSize\(imageSize: image\.size, in: viewportSize\)/);
  assert.match(preview, /width: fittedSize\.width \* scale/);
  assert.match(preview, /height: fittedSize\.height \* scale/);
  assert.match(preview, /let fitScale = min\(widthScale, heightScale\)/);
  assert.doesNotMatch(preview, /\.scaleEffect\(scale\)/);
});

test("Android and macOS ship the same static Hermes command names", () => {
  const androidNames = commandNames(
    sources.android,
    /command(?:Aliases)?\("([a-z0-9_-]+)"/g,
  );
  const macNames = commandNames(
    sources.macos,
    /command\("([a-z0-9_-]+)"/g,
  );
  assert.deepEqual(macNames, androidNames);
  assert.ok(macNames.includes("reset"));
  assert.ok(macNames.includes("model"));
  assert.ok(macNames.includes("approve"));
});

test("Android and macOS send ordinary durable messages with the same direct envelope shape", () => {
  assert.match(sources.android, /if \(!send\(spaceId, envelope\)\)/);
  assert.match(sources.macos, /frame: try Self\.outgoingMessageFrame\(envelope\)/);
  assert.match(sources.macos, /#expect\(frame\["message"\] == nil\)/);
});

async function readSources(paths) {
  const contents = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
  return contents.join("\n");
}

function commandNames(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}
