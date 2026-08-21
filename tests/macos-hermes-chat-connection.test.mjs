import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientPath = new URL(
  "../macos/AIBuildNotes/Sources/NotesCore/HermesChatClient.swift",
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

test("macOS scheduled reconnect does not cancel its own task", async () => {
  const source = await readFile(storePath, "utf8");
  const connectStart = source.indexOf("  private func connectConfiguredProfiles(");
  const eventHandlerStart = source.indexOf("  private func handle(_ event:", connectStart);
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

test("macOS defers conversation selection mutations until after SwiftUI updates", async () => {
  const source = await readFile(viewsPath, "utf8");

  assert.match(
    source,
    /set: \{ requestedProfileID in[\s\S]*?await Task\.yield\(\)[\s\S]*?store\.selectProfile\(requestedProfileID\)/,
  );
});
