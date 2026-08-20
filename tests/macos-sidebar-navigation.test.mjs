import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootViewPath = new URL(
  "../macos/AIBuildNotes/Sources/AIBuildNotes/RootView.swift",
  import.meta.url,
);

test("macOS sidebar uses one native selection for every workspace destination", async () => {
  const source = await readFile(rootViewPath, "utf8");

  assert.match(source, /private enum SidebarDestination: Hashable/);
  assert.match(source, /case notes\(NoteLocation\)/);
  assert.match(source, /case hermes/);
  assert.match(source, /case cloudflareBilling/);
  assert.match(source, /List\(selection: \$selection\)/);
  assert.match(source, /\.tag\(SidebarDestination\.hermes\)/);
  assert.match(source, /\.tag\(SidebarDestination\.cloudflareBilling\)/);
  assert.match(source, /\.tag\(SidebarDestination\.notes\(location\)\)/);
  assert.doesNotMatch(source, /\.onTapGesture\s*\{\s*workspaceMode = \.notes\s*\}/);
  assert.doesNotMatch(source, /private var locationBinding/);
});

test("macOS sidebar defers NotesStore publication beyond the List view update", async () => {
  const source = await readFile(rootViewPath, "utf8");

  assert.match(source, /\.onChange\(of: sidebarDestination\)/);
  assert.match(
    source,
    /Task \{ @MainActor in[\s\S]*?await Task\.yield\(\)[\s\S]*?store\.selectLocation\(location\)/,
  );
});
