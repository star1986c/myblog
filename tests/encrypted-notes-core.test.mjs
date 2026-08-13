import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptNote,
  encryptNote,
  importNoteDataKey,
  normalizeEncryptedNote,
} from "../public/assets/encrypted-notes-core.20260813-v2.js";

async function makeDataKey(seed = 1) {
  const raw = new Uint8Array(32).fill(seed);
  return await importNoteDataKey(Buffer.from(raw).toString("base64url"));
}

test("encrypts note title and content without exposing plaintext", async () => {
  const dataKey = await makeDataKey();
  const note = {
    title: "银行与邮箱账号",
    content: "user@example.com\nprivate-password-value",
  };
  const envelope = await encryptNote(dataKey, "note_12345678", note);

  assert.doesNotMatch(JSON.stringify(envelope), /银行|example\.com|private-password-value/);
  assert.deepEqual(await decryptNote(dataKey, envelope), note);
});

test("binds encrypted note ciphertext to its record id", async () => {
  const dataKey = await makeDataKey(2);
  const envelope = await encryptNote(dataKey, "note_12345678", {
    title: "SSH",
    content: "root secret",
  });

  await assert.rejects(decryptNote(dataKey, { ...envelope, id: "note_87654321" }));
});

test("imports only 256-bit workspace data keys", async () => {
  await assert.rejects(importNoteDataKey(Buffer.from(new Uint8Array(16)).toString("base64url")));
});

test("normalizes empty titles while preserving note whitespace", () => {
  assert.deepEqual(normalizeEncryptedNote({ title: "  ", content: "  secret\n" }), {
    title: "无标题笔记",
    content: "  secret\n",
  });
});
