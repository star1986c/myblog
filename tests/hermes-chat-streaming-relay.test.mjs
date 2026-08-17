import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roomPath = new URL("../src/hermes-chat-room.js", import.meta.url);

test("relay persists only final stream edits and broadcasts intermediate edits", async () => {
  const source = await readFile(roomPath, "utf8");

  assert.match(source, /validateHermesChatEdit/);
  assert.match(source, /ensureEditableTarget\(edit\.targetSeq\)/);
  assert.match(source, /edit\.final\s*\?\s*this\.storeStreamEdit\(edit\)/);
  assert.match(source, /buildHermesChatDeliveryFrame/);
});
