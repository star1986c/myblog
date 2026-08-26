import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewsPath = new URL(
  "../macos/AIBuildNotes/Sources/AIBuildNotes/HermesChatViews.swift",
  import.meta.url,
);

test("macOS bounds normal and local-search message rendering with explicit load-more controls", async () => {
  const source = await readFile(viewsPath, "utf8");

  assert.match(source, /@State private var visibleMessageLimit = 160/);
  assert.match(source, /@State private var visibleSearchResultLimit = 160/);
  assert.match(source, /Array\(messages\.suffix\(visibleMessageLimit\)\)/);
  assert.match(source, /Array\(matchingMessages\.suffix\(visibleSearchResultLimit\)\)/);
  assert.match(source, /visibleMessageLimit \+= 160/);
  assert.match(source, /visibleSearchResultLimit \+= 160/);
  assert.match(source, /加载更早的本地消息/);
  assert.match(source, /加载更早的搜索结果/);
});

test("macOS Hermes composer submission uses the same send guard as the button", async () => {
  const source = await readFile(viewsPath, "utf8");

  assert.match(
    source,
    /HermesMessageEditor\(text: \$draft, isFocused: \$composerFocused, onSubmit: send\)/,
  );
  assert.match(source, /\.disabled\(!canSend\)/);
  assert.match(
    source,
    /private var canSend: Bool \{\s*!store\.isSending\s*&& \(!draft\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty\s*\|\| !selectedFiles\.isEmpty\)/,
  );
  assert.match(source, /private func send\(\) \{\s*guard canSend else \{ return \}/);
  assert.match(source, /\.keyboardShortcut\(\.return, modifiers: \.command\)/);
  assert.match(source, /Shift\+回车换行/);
});
