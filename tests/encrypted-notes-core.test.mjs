import assert from "node:assert/strict";
import test from "node:test";
import { createPasswordVault } from "../public/assets/password-vault-core.20260713.js";
import {
  decryptNote,
  encryptNote,
  normalizeEncryptedNote,
} from "../public/assets/encrypted-notes-core.20260813.js";

test("encrypts note title and content without exposing plaintext", async () => {
  const { dataKey } = await createPasswordVault("correct horse battery staple");
  const note = {
    title: "银行与邮箱账号",
    content: "user@example.com\nprivate-password-value",
  };
  const envelope = await encryptNote(dataKey, "note_12345678", note);

  assert.doesNotMatch(JSON.stringify(envelope), /银行|example\.com|private-password-value/);
  assert.deepEqual(await decryptNote(dataKey, envelope), note);
});

test("binds encrypted note ciphertext to its record id", async () => {
  const { dataKey } = await createPasswordVault("correct horse battery staple");
  const envelope = await encryptNote(dataKey, "note_12345678", {
    title: "SSH",
    content: "root secret",
  });

  await assert.rejects(decryptNote(dataKey, { ...envelope, id: "note_87654321" }));
});

test("normalizes empty titles while preserving note whitespace", () => {
  assert.deepEqual(normalizeEncryptedNote({ title: "  ", content: "  secret\n" }), {
    title: "无标题笔记",
    content: "  secret\n",
  });
});
