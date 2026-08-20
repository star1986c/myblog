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
