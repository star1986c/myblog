import { ServiceError } from "./blog-repository.js";

const MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES = 10 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_CIPHERTEXT_BYTES = MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES + 16;
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function attachmentObjectKey(spaceId, attachmentId) {
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

export {
  MAX_CHAT_ATTACHMENT_CIPHERTEXT_BYTES,
  downloadHermesChatAttachment,
  uploadHermesChatAttachment,
};
