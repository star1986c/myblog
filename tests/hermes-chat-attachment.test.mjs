import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadHermesChatAttachment,
  uploadHermesChatAttachment,
} from "../src/hermes-chat-attachment-repository.js";

function memoryBucket() {
  const values = new Map();
  return {
    values,
    async put(key, body, options) {
      if (options.onlyIf?.etagDoesNotMatch === "*" && values.has(key)) return null;
      const data = new Uint8Array(await new Response(body).arrayBuffer());
      values.set(key, {
        data,
        options,
      });
      return { key, size: data.byteLength };
    },
    async get(key) {
      const value = values.get(key);
      if (!value) return null;
      return {
        body: value.data,
        size: value.data.byteLength,
      };
    },
  };
}

test("stores encrypted Hermes chat attachments under an isolated R2 prefix", async () => {
  const bucket = memoryBucket();
  const attachmentId = "550e8400-e29b-41d4-a716-446655440000";
  const ciphertext = new Uint8Array(32).fill(7);
  const request = new Request("https://example.com/upload", {
    method: "POST",
    headers: {
      "Content-Length": String(ciphertext.byteLength),
      "Content-Type": "application/octet-stream",
    },
    body: ciphertext,
    duplex: "half",
  });

  const uploaded = await uploadHermesChatAttachment(bucket, request, {
    attachmentId,
    spaceId: "default",
    uploader: "client:star",
  });
  const downloaded = await downloadHermesChatAttachment(bucket, {
    attachmentId,
    spaceId: "default",
  });

  assert.equal(uploaded.ciphertextBytes, ciphertext.byteLength);
  assert.ok(bucket.values.has(`hermes-chat/v1/default/${attachmentId}`));
  assert.deepEqual(new Uint8Array(downloaded.body), ciphertext);
});

test("rejects plaintext media types and duplicate attachment ids", async () => {
  const bucket = memoryBucket();
  const attachmentId = "550e8400-e29b-41d4-a716-446655440000";
  const encryptedRequest = () => new Request("https://example.com/upload", {
    method: "POST",
    headers: { "Content-Length": "32", "Content-Type": "application/octet-stream" },
    body: new Uint8Array(32),
    duplex: "half",
  });
  await uploadHermesChatAttachment(bucket, encryptedRequest(), {
    attachmentId,
    spaceId: "default",
    uploader: "client:star",
  });
  await assert.rejects(
    uploadHermesChatAttachment(bucket, encryptedRequest(), {
      attachmentId,
      spaceId: "default",
      uploader: "client:star",
    }),
    /already exists/i,
  );

  const plaintextRequest = new Request("https://example.com/upload", {
    method: "POST",
    headers: { "Content-Length": "32", "Content-Type": "image/jpeg" },
    body: new Uint8Array(32),
    duplex: "half",
  });
  await assert.rejects(
    uploadHermesChatAttachment(bucket, plaintextRequest, {
      attachmentId: "550e8400-e29b-41d4-a716-446655440001",
      spaceId: "default",
      uploader: "client:star",
    }),
    /encrypted binary/i,
  );
});
