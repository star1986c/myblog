import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptNote,
  decryptProtectedBody,
  encryptNote,
  encryptProtectedBody,
  importNoteDataKey,
  createProtectionKeyring,
  unlockProtectionKeyring,
  normalizeEncryptedNote,
} from "../public/assets/encrypted-notes-core.20260814-v3.js";

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

test("one independent password protects multiple note bodies", async () => {
  const password = "correct horse battery staple";
  const created = await createProtectionKeyring(password);
  const keyring = { ...created.payload, revision: 1 };
  const key = await unlockProtectionKeyring(keyring, password);
  const first = await encryptProtectedBody(key, "note_12345678", "first secret");
  const second = await encryptProtectedBody(key, "note_87654321", "second secret");
  assert.equal(await decryptProtectedBody(key, "note_12345678", first), "first secret");
  assert.equal(await decryptProtectedBody(key, "note_87654321", second), "second secret");
  await assert.rejects(unlockProtectionKeyring(keyring, "definitely-wrong-password"));
});
