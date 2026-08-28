import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientPath = new URL(
  "../macos/AIBuildNotes/Sources/NotesCore/HermesChatClient.swift",
  import.meta.url,
);
const infoPlistPath = new URL(
  "../macos/AIBuildNotes/Info.plist",
  import.meta.url,
);
const storePath = new URL(
  "../macos/AIBuildNotes/Sources/NotesCore/HermesChatStore.swift",
  import.meta.url,
);
const viewsPath = new URL(
  "../macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatViews.swift",
  import.meta.url,
);

test("macOS abandons a WebSocket handshake that never reaches ready", async () => {
  const source = await readFile(clientPath, "utf8");

  assert.match(source, /private var handshakeTask: Task<Void, Never>\?/);
  assert.match(source, /makeHandshakeWatchdog\(timeout: handshakeTimeout\)/);
  assert.match(source, /failHandshakeIfPending\(socket: task, generation: currentGeneration\)/);
  assert.match(source, /WebSocket 握手超时，正在自动重试/);
  assert.match(source, /handshakeTask\?\.cancel\(\)/);
});

test("macOS Hermes User-Agent matches the app marketing version", async () => {
  const [clientSource, infoPlist] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(infoPlistPath, "utf8"),
  ]);
  const version = infoPlist.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
  )?.[1];

  assert.ok(version, "CFBundleShortVersionString must be present");
  assert.match(
    clientSource,
    new RegExp(`My-Notes-macOS/${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("macOS scheduled reconnect does not cancel its own task", async () => {
  const source = await readFile(storePath, "utf8");
  const connectStart = source.indexOf("  private func connectConfiguredProfiles(");
  const eventHandlerStart = source.indexOf("  func handle(_ event:", connectStart);
  const disconnectStart = source.indexOf("  private func handleDisconnect(reason:");
  const cacheStart = source.indexOf("  private func cacheProfiles(", disconnectStart);

  assert.notEqual(connectStart, -1);
  assert.notEqual(eventHandlerStart, -1);
  assert.notEqual(disconnectStart, -1);
  assert.notEqual(cacheStart, -1);

  const connectSource = source.slice(connectStart, eventHandlerStart);
  const disconnectSource = source.slice(disconnectStart, cacheStart);

  assert.doesNotMatch(connectSource, /reconnectTask\?\.cancel\(\)/);
  assert.match(
    source,
    /private func runScheduledReconnect\(\) async \{[\s\S]*?reconnectTask = nil[\s\S]*?await connectConfiguredProfiles\(\)/,
  );
  assert.match(
    disconnectSource,
    /reconnectTask = Task \{ \[weak self\] in[\s\S]*?await self\?\.runScheduledReconnect\(\)/,
  );
});

test("macOS starts tokenized awaiting before WebSocket sends", async () => {
  const source = await readFile(storePath, "utf8");
  const sendStart = source.indexOf("  public func send(");
  const sendEnd = source.indexOf("  public func sendTyping(", sendStart);
  const interactionStart = source.indexOf("  public func chooseInteractionOption(", sendEnd);
  const interactionEnd = source.indexOf("  public func attachmentData(", interactionStart);
  const markAwaitingStart = source.indexOf("  func markAwaiting(");
  const markTypingStart = source.indexOf("  private func markTyping(", markAwaitingStart);

  assert.notEqual(sendStart, -1);
  assert.notEqual(sendEnd, -1);
  assert.notEqual(interactionStart, -1);
  assert.notEqual(interactionEnd, -1);
  assert.notEqual(markAwaitingStart, -1);
  assert.notEqual(markTypingStart, -1);

  const sendSource = source.slice(sendStart, sendEnd);
  const interactionSource = source.slice(interactionStart, interactionEnd);
  const awaitingSource = source.slice(markAwaitingStart, markTypingStart);
  const uploadIndex = sendSource.indexOf("try await api.uploadHermesChatAttachment(");
  const markIndex = sendSource.indexOf("awaitingGeneration = markAwaiting(spaceID)");
  const webSocketSendIndex = sendSource.indexOf("let message = try await client.sendMessage(");

  assert.notEqual(uploadIndex, -1);
  assert.notEqual(markIndex, -1);
  assert.notEqual(webSocketSendIndex, -1);
  assert.ok(uploadIndex < markIndex, "attachments must finish uploading before awaiting starts");
  assert.ok(markIndex < webSocketSendIndex, "awaiting must start before the WebSocket send await");
  assert.match(
    sendSource,
    /catch \{[\s\S]*cancelAwaiting\(spaceID, generation: awaitingGeneration\)/,
  );
  assert.match(
    interactionSource,
    /let actionID = UUID\(\)\.uuidString\.lowercased\(\)[\s\S]*let awaitingGeneration = markAwaiting\(spaceID\)[\s\S]*registerAwaitingAction\(actionID[\s\S]*client\.sendInteractionAction[\s\S]*messageID: actionID[\s\S]*catch \{[\s\S]*cancelAwaiting\(spaceID, generation: awaitingGeneration\)/,
  );
  assert.match(
    awaitingSource,
    /awaitingGenerations\[spaceID\] = generation[\s\S]*guard awaitingGenerations\[spaceID\] == generation else \{ return \}/,
  );
});

test("macOS binds negative action ACKs and attachment sends to their generations", async () => {
  const [clientSource, storeSource] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);

  assert.match(
    storeSource,
    /actionAwaitingGenerations\.removeValue\(forKey: actionID\)[\s\S]*cancelAwaiting\(spaceID, generation: pending\.generation\)/,
  );
  assert.match(
    storeSource,
    /let sendConfigurationGeneration = configurationGeneration[\s\S]*guard sendConfigurationGeneration == configurationGeneration[\s\S]*expectedConfigurationGeneration: sendConfigurationGeneration[\s\S]*guard sendConfigurationGeneration == configurationGeneration/,
  );
  assert.match(
    clientSource,
    /profile\.configurationGeneration == expectedConfigurationGeneration/,
  );
  assert.match(
    storeSource,
    /configurationGeneration \+= 1[\s\S]*let generation = configurationGeneration[\s\S]*await client\.disconnect\(\)[\s\S]*guard generation == configurationGeneration/,
  );
  assert.match(
    storeSource,
    /case \.message\(let spaceID, let message, let eventGeneration\):[\s\S]*guard eventGeneration == configurationGeneration/,
  );
});

test("macOS typing fences preserve awaiting while terminal stops clear it", async () => {
  const [clientSource, storeSource] = await Promise.all([
    readFile(clientPath, "utf8"),
    readFile(storePath, "utf8"),
  ]);

  assert.match(
    clientSource,
    /let terminal = !active && \(frame\["terminal"\] as\? Bool \?\? true\)/,
  );
  assert.match(
    storeSource,
    /case \.typing\(let spaceID, let active, let terminal, let eventGeneration\):[\s\S]*guard eventGeneration == configurationGeneration[\s\S]*cancelTyping\(spaceID\)[\s\S]*if terminal \{ cancelAwaiting\(spaceID\) \}/,
  );
});

test("macOS WebSocket generations fence invalid connects and reordered typing sends", async () => {
  const source = await readFile(clientPath, "utf8");
  const connectStart = source.indexOf("  public func connect(");
  const disconnectStart = source.indexOf("  public func disconnect()", connectStart);
  const connectSource = source.slice(connectStart, disconnectStart);
  const typingStart = source.indexOf("  public func sendTyping(");
  const receiveStart = source.indexOf("  private func receiveLoop(", typingStart);
  const typingSource = source.slice(typingStart, receiveStart);

  const generationIndex = connectSource.indexOf("generation += 1");
  const closeIndex = connectSource.indexOf("closeCurrentSocket(");
  const ticketGuardIndex = connectSource.indexOf("guard !configured.isEmpty");
  assert.ok(generationIndex >= 0 && generationIndex < closeIndex);
  assert.ok(closeIndex < ticketGuardIndex);
  assert.match(connectSource, /guard !configured\.isEmpty[\s\S]*profiles = \[:\][\s\S]*closing = true/);
  assert.match(
    typingSource,
    /if let pending = typingOperations\[spaceID\][\s\S]*pending\.active != active[\s\S]*else if profile\.lastTypingActive == active[\s\S]*nextTypingOperation &\+= 1[\s\S]*PendingTypingOperation\(id: typingOperation, active: active\)[\s\S]*try await sendRouted[\s\S]*typingOperations\[spaceID\]\?\.id == typingOperation/,
  );
  assert.match(
    typingSource,
    /catch \{[\s\S]*typingOperations\[spaceID\]\?\.id == typingOperation[\s\S]*typingOperations\.removeValue\(forKey: spaceID\)[\s\S]*current\.lastTypingActive = nil/,
  );
});

test("macOS defers conversation selection mutations until after SwiftUI updates", async () => {
  const source = await readFile(viewsPath, "utf8");

  assert.match(
    source,
    /set: \{ requestedProfileID in[\s\S]*?await Task\.yield\(\)[\s\S]*?store\.selectProfile\(requestedProfileID\)/,
  );
});
