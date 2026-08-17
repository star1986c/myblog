import { ServiceError } from "./blog-repository.js";

const MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_CIPHERTEXT_BYTES = MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES + 16;
const MAX_MANUAL_DELETE_PAGES = 100;
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function uploadHermesChatAttachment(bucket, request, { attachmentId, spaceId, uploader }) {
  requireBucket(bucket);
  requireAttachmentId(attachmentId);
  if ((request.headers.get("Content-Type") || "").split(";", 1)[0] !== "application/octet-stream") {
    throw new ServiceError("Hermes chat attachments must be encrypted binary data.", 415);
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 17 ||
    contentLength > MAX_CHAT_ATTACHMENT_CIPHERTEXT_BYTES
  ) {
    throw new ServiceError("Hermes chat attachment exceeds the 10 MiB limit.", 413);
  }
  if (!request.body) throw new ServiceError("Hermes chat attachment body is required.", 400);

  const objectKey = attachmentObjectKey(spaceId, attachmentId);
  const stored = await bucket.put(objectKey, request.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      kind: "hermes-chat-encrypted-v1",
      uploader: String(uploader || "unknown").slice(0, 128),
      createdAt: new Date().toISOString(),
    },
  });
  if (!stored) throw new ServiceError("Hermes chat attachment already exists.", 409);
  return {
    id: attachmentId,
    ciphertextBytes: contentLength,
  };
}

async function downloadHermesChatAttachment(bucket, { attachmentId, spaceId }) {
  requireBucket(bucket);
  requireAttachmentId(attachmentId);
  const object = await bucket.get(attachmentObjectKey(spaceId, attachmentId));
  if (!object) throw new ServiceError("Hermes chat attachment not found.", 404);
  return object;
}

async function deleteHermesChatAttachments(bucket, { spaceId }) {
  requireListDeleteBucket(bucket);
  const prefix = `${attachmentObjectKey(spaceId, "")}`;
  let attachmentsDeleted = 0;
  let ciphertextBytesDeleted = 0;
  let listRequests = 0;

  for (let page = 0; page < MAX_MANUAL_DELETE_PAGES; page += 1) {
    const listed = await bucket.list({ prefix, limit: 1000 });
    listRequests += 1;
    const objects = Array.isArray(listed?.objects) ? listed.objects : [];
    const keys = objects
      .map((object) => String(object?.key || ""))
      .filter((key) => key.startsWith(prefix));
    if (keys.length) {
      await bucket.delete(keys);
      attachmentsDeleted += keys.length;
      ciphertextBytesDeleted += objects.reduce((total, object) => (
        total + (Number.isSafeInteger(object?.size) && object.size > 0 ? object.size : 0)
      ), 0);
    }
    if (listed?.truncated !== true) {
      return { attachmentsDeleted, ciphertextBytesDeleted, listRequests };
    }
  }

  throw new ServiceError(
    "Hermes chat attachment cleanup reached its safe page limit; retry cleanup.",
    503,
  );
}

function attachmentObjectKey(spaceId, attachmentId) {
  requireSpaceId(spaceId);
  return `hermes-chat/v1/${spaceId}/${attachmentId}`;
}

function requireAttachmentId(value) {
  if (!ATTACHMENT_ID_PATTERN.test(String(value || ""))) {
    throw new ServiceError("Invalid Hermes chat attachment id.", 400);
  }
}

function requireBucket(bucket) {
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
    throw new ServiceError("Hermes chat attachment storage is unavailable.", 503);
  }
}

function requireListDeleteBucket(bucket) {
  if (!bucket || typeof bucket.list !== "function" || typeof bucket.delete !== "function") {
    throw new ServiceError("Hermes chat attachment storage is unavailable.", 503);
  }
}

function requireSpaceId(value) {
  if (!SPACE_ID_PATTERN.test(String(value || ""))) {
    throw new ServiceError("Invalid Hermes chat space.", 400);
  }
}

export {
  MAX_CHAT_ATTACHMENT_CIPHERTEXT_BYTES,
  deleteHermesChatAttachments,
  downloadHermesChatAttachment,
  uploadHermesChatAttachment,
};
