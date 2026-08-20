import assert from "node:assert/strict";
import test from "node:test";

import {
  HERMES_CHAT_PRIVATE_STORAGE,
  cancelHermesChatDirectUpload,
  confirmHermesChatDirectUpload,
  createHermesChatDirectDownloadTicket,
  createHermesChatDirectUploadTicket,
} from "../src/hermes-chat-direct-upload.js";

const ATTACHMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PLAINTEXT_BYTES = 11 * 1024 * 1024;
const SHA256 = "ab".repeat(32);

function signingEnv(bucket) {
  return {
    NOTE_ATTACHMENTS: bucket,
    HERMES_CHAT_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    HERMES_CHAT_R2_BUCKET_NAME: "notes",
    HERMES_CHAT_R2_ACCESS_KEY_ID: "test-access-key",
    HERMES_CHAT_R2_SECRET_ACCESS_KEY: "test-secret-key",
  };
}

function memoryHeadBucket(object = null) {
  let stored = object;
  let deleted = false;
  return {
    get deleted() {
      return deleted;
    },
    set object(value) {
      stored = value;
    },
    async head() {
      return stored;
    },
    async delete() {
      deleted = true;
      stored = null;
    },
  };
}

function directObject(overrides = {}) {
  return {
    size: PLAINTEXT_BYTES,
    customMetadata: {
      kind: HERMES_CHAT_PRIVATE_STORAGE,
      uploader: "agent:nas-primary",
      "plaintext-bytes": String(PLAINTEXT_BYTES),
      sha256: SHA256,
    },
    checksums: {
      sha256: Uint8Array.from({ length: 32 }, () => 0xab),
    },
    ...overrides,
  };
}

test("creates an Agent-only R2 PUT ticket with signed integrity headers", async () => {
  const ticket = await createHermesChatDirectUploadTicket(
    signingEnv(memoryHeadBucket()),
    {
      attachmentId: ATTACHMENT_ID,
      spaceId: "primary",
      agentId: "nas-primary",
      plaintextBytes: PLAINTEXT_BYTES,
      sha256: SHA256.toUpperCase(),
    },
  );

  const url = new URL(ticket.uploadUrl);
  assert.equal(ticket.storage, HERMES_CHAT_PRIVATE_STORAGE);
  assert.equal(ticket.plaintextBytes, PLAINTEXT_BYTES);
  assert.equal(ticket.sha256, SHA256);
  assert.equal(url.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(url.pathname, `/notes/hermes-chat/v1/primary/${ATTACHMENT_ID}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "1800");
  assert.ok(url.searchParams.get("X-Amz-Signature"));
  assert.equal(ticket.requiredHeaders["If-None-Match"], "*");
  assert.equal(ticket.requiredHeaders["x-amz-meta-kind"], HERMES_CHAT_PRIVATE_STORAGE);
  assert.equal(ticket.requiredHeaders["x-amz-meta-uploader"], "agent:nas-primary");
  assert.equal(ticket.requiredHeaders["x-amz-checksum-sha256"], "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=");
});

test("confirms metadata and R2 checksum before publishing an attachment", async () => {
  const bucket = memoryHeadBucket(directObject());
  const result = await confirmHermesChatDirectUpload(signingEnv(bucket), {
    attachmentId: ATTACHMENT_ID,
    spaceId: "primary",
    agentId: "nas-primary",
    plaintextBytes: PLAINTEXT_BYTES,
    sha256: SHA256,
  });

  assert.deepEqual(result, {
    id: ATTACHMENT_ID,
    storage: HERMES_CHAT_PRIVATE_STORAGE,
    plaintextBytes: PLAINTEXT_BYTES,
    sha256: SHA256,
  });
  assert.equal(bucket.deleted, false);
});

test("deletes a failed Agent-owned upload instead of publishing it", async () => {
  const bucket = memoryHeadBucket(directObject({ size: PLAINTEXT_BYTES - 1 }));
  await assert.rejects(
    confirmHermesChatDirectUpload(signingEnv(bucket), {
      attachmentId: ATTACHMENT_ID,
      spaceId: "primary",
      agentId: "nas-primary",
      plaintextBytes: PLAINTEXT_BYTES,
      sha256: SHA256,
    }),
    /integrity verification/i,
  );
  assert.equal(bucket.deleted, true);
});

test("issues private GET tickets and only the owning Agent can cancel", async () => {
  const bucket = memoryHeadBucket(directObject());
  const ticket = await createHermesChatDirectDownloadTicket(signingEnv(bucket), {
    attachmentId: ATTACHMENT_ID,
    spaceId: "primary",
  });
  const url = new URL(ticket.downloadUrl);
  assert.equal(ticket.storage, HERMES_CHAT_PRIVATE_STORAGE);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.ok(url.searchParams.get("X-Amz-Signature"));

  await assert.rejects(
    cancelHermesChatDirectUpload(signingEnv(bucket), {
      attachmentId: ATTACHMENT_ID,
      spaceId: "primary",
      agentId: "nas-personal",
    }),
    /cannot be cancelled/i,
  );
  assert.equal(bucket.deleted, false);

  assert.deepEqual(
    await cancelHermesChatDirectUpload(signingEnv(bucket), {
      attachmentId: ATTACHMENT_ID,
      spaceId: "primary",
      agentId: "nas-primary",
    }),
    { deleted: true },
  );
  assert.equal(bucket.deleted, true);
});

test("refuses GET tickets when direct-object provenance or checksum is invalid", async () => {
  for (const object of [
    directObject({
      customMetadata: {
        kind: HERMES_CHAT_PRIVATE_STORAGE,
        uploader: "client:forged",
        "plaintext-bytes": String(PLAINTEXT_BYTES),
        sha256: SHA256,
      },
    }),
    directObject({
      checksums: { sha256: Uint8Array.from({ length: 32 }, () => 0xcd) },
    }),
    directObject({ checksums: {} }),
  ]) {
    await assert.rejects(
      createHermesChatDirectDownloadTicket(
        signingEnv(memoryHeadBucket(object)),
        { attachmentId: ATTACHMENT_ID, spaceId: "primary" },
      ),
      /metadata is invalid/i,
    );
  }
});

test("keeps client-sized attachments on the encrypted upload path", async () => {
  await assert.rejects(
    createHermesChatDirectUploadTicket(signingEnv(memoryHeadBucket()), {
      attachmentId: ATTACHMENT_ID,
      spaceId: "primary",
      agentId: "nas-primary",
      plaintextBytes: 10 * 1024 * 1024,
      sha256: SHA256,
    }),
    /outside the allowed range/i,
  );
});
