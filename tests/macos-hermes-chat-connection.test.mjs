import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientPath = new URL(
  "../macos/AIBuildNotes/Sources/NotesCore/HermesChatClient.swift",
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

test("macOS defers conversation selection mutations until after SwiftUI updates", async () => {
  const source = await readFile(viewsPath, "utf8");

  assert.match(
    source,
    /set: \{ requestedProfileID in[\s\S]*?await Task\.yield\(\)[\s\S]*?store\.selectProfile\(requestedProfileID\)/,
  );
});
