import { AwsClient } from "aws4fetch";

import { ServiceError } from "./blog-repository.js";
import {
  MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES,
  attachmentObjectKey,
} from "./hermes-chat-attachment-repository.js";

const HERMES_CHAT_PRIVATE_STORAGE = "r2-private-v1";
const DEFAULT_AGENT_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024;
const ABSOLUTE_AGENT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_UPLOAD_TICKET_TTL_SECONDS = 30 * 60;
const DEFAULT_DOWNLOAD_TICKET_TTL_SECONDS = 15 * 60;
const MAX_TICKET_TTL_SECONDS = 60 * 60;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

async function createHermesChatDirectUploadTicket(env, {
  attachmentId,
  spaceId,
  agentId,
  plaintextBytes,
  sha256,
}) {
  const expected = requireDirectAttachment({
    attachmentId,
    spaceId,
    plaintextBytes,
    sha256,
    maximumBytes: resolveHermesChatAgentAttachmentMaxBytes(env),
  });
  const bucket = requireHeadBucket(env.NOTE_ATTACHMENTS);
  const objectKey = attachmentObjectKey(spaceId, attachmentId);
  if (await bucket.head(objectKey)) {
    throw new ServiceError("Hermes chat attachment already exists.", 409);
  }

  const ttlSeconds = resolveTicketTtl(
    env.HERMES_CHAT_R2_UPLOAD_TICKET_TTL_SECONDS,
    DEFAULT_UPLOAD_TICKET_TTL_SECONDS,
  );
  const uploader = requireAgentUploader(agentId);
  const createdAt = new Date().toISOString();
  const requiredHeaders = {
    "Content-Type": "application/octet-stream",
    "If-None-Match": "*",
    "x-amz-checksum-sha256": hexToBase64(expected.sha256),
    "x-amz-meta-created-at": createdAt,
    "x-amz-meta-kind": HERMES_CHAT_PRIVATE_STORAGE,
    "x-amz-meta-plaintext-bytes": String(expected.plaintextBytes),
    "x-amz-meta-sha256": expected.sha256,
    "x-amz-meta-uploader": uploader,
  };
  const uploadUrl = await presignR2Request(env, objectKey, {
    method: "PUT",
    headers: requiredHeaders,
    ttlSeconds,
  });
  return {
    attachmentId,
    storage: HERMES_CHAT_PRIVATE_STORAGE,
    plaintextBytes: expected.plaintextBytes,
    sha256: expected.sha256,
    uploadUrl,
    requiredHeaders,
    expiresInSeconds: ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

async function confirmHermesChatDirectUpload(env, {
  attachmentId,
  spaceId,
  agentId,
  plaintextBytes,
  sha256,
}) {
  const expected = requireDirectAttachment({
    attachmentId,
    spaceId,
    plaintextBytes,
    sha256,
    maximumBytes: resolveHermesChatAgentAttachmentMaxBytes(env),
  });
  const bucket = requireHeadDeleteBucket(env.NOTE_ATTACHMENTS);
  const objectKey = attachmentObjectKey(spaceId, attachmentId);
  const object = await bucket.head(objectKey);
  if (!object) throw new ServiceError("Hermes chat attachment upload was not found.", 404);

  const metadata = normalizeMetadata(object.customMetadata);
  const uploader = requireAgentUploader(agentId);
  const ownedDirectObject = metadata.kind === HERMES_CHAT_PRIVATE_STORAGE
    && metadata.uploader === uploader;
  const checksum = checksumHex(object.checksums?.sha256);
  const valid = ownedDirectObject
    && object.size === expected.plaintextBytes
    && metadata["plaintext-bytes"] === String(expected.plaintextBytes)
    && metadata.sha256 === expected.sha256
    && checksum === expected.sha256;

  if (!valid) {
    if (ownedDirectObject) await bucket.delete(objectKey);
    throw new ServiceError("Hermes chat attachment upload failed integrity verification.", 422);
  }
  return {
    id: attachmentId,
    storage: HERMES_CHAT_PRIVATE_STORAGE,
    plaintextBytes: expected.plaintextBytes,
    sha256: expected.sha256,
  };
}

async function cancelHermesChatDirectUpload(env, { attachmentId, spaceId, agentId }) {
  const bucket = requireHeadDeleteBucket(env.NOTE_ATTACHMENTS);
  const objectKey = attachmentObjectKey(spaceId, attachmentId);
  const object = await bucket.head(objectKey);
  if (!object) return { deleted: false };
  const metadata = normalizeMetadata(object.customMetadata);
  if (
    metadata.kind !== HERMES_CHAT_PRIVATE_STORAGE
    || metadata.uploader !== requireAgentUploader(agentId)
  ) {
    throw new ServiceError("Hermes chat attachment cannot be cancelled.", 409);
  }
  await bucket.delete(objectKey);
  return { deleted: true };
}

async function createHermesChatDirectDownloadTicket(env, { attachmentId, spaceId }) {
  const bucket = requireHeadBucket(env.NOTE_ATTACHMENTS);
  const objectKey = attachmentObjectKey(spaceId, attachmentId);
  const object = await bucket.head(objectKey);
  if (!object) throw new ServiceError("Hermes chat attachment not found.", 404);
  const metadata = normalizeMetadata(object.customMetadata);
  const plaintextBytes = Number(metadata["plaintext-bytes"]);
  const sha256 = String(metadata.sha256 || "").toLowerCase();
  const checksum = checksumHex(object.checksums?.sha256);
  if (
    metadata.kind !== HERMES_CHAT_PRIVATE_STORAGE
    || !/^agent:[A-Za-z0-9_.:@-]{1,128}$/.test(metadata.uploader || "")
    || !Number.isSafeInteger(plaintextBytes)
    || plaintextBytes !== object.size
    || plaintextBytes <= MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES
    || plaintextBytes > resolveHermesChatAgentAttachmentMaxBytes(env)
    || !SHA256_PATTERN.test(sha256)
    || checksum !== sha256
  ) {
    throw new ServiceError("Hermes chat attachment metadata is invalid.", 422);
  }

  const ttlSeconds = resolveTicketTtl(
    env.HERMES_CHAT_R2_DOWNLOAD_TICKET_TTL_SECONDS,
    DEFAULT_DOWNLOAD_TICKET_TTL_SECONDS,
  );
  return {
    attachmentId,
    storage: HERMES_CHAT_PRIVATE_STORAGE,
    plaintextBytes,
    sha256,
    downloadUrl: await presignR2Request(env, objectKey, {
      method: "GET",
      headers: {},
      ttlSeconds,
    }),
    expiresInSeconds: ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

async function presignR2Request(env, objectKey, { method, headers, ttlSeconds }) {
  const config = requireR2SigningConfig(env);
  const path = [config.bucketName, ...objectKey.split("/")]
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${path}`);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const signed = await client.sign(url, {
    method,
    headers,
    aws: { signQuery: true },
  });
  return signed.url;
}

function requireDirectAttachment({
  attachmentId,
  spaceId,
  plaintextBytes,
  sha256,
  maximumBytes,
}) {
  attachmentObjectKey(spaceId, attachmentId);
  const bytes = Number(plaintextBytes);
  if (
    !Number.isSafeInteger(bytes)
    || bytes <= MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES
    || bytes > maximumBytes
  ) {
    throw new ServiceError("Hermes Agent attachment size is outside the allowed range.", 413);
  }
  const normalizedSha256 = String(sha256 || "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalizedSha256)) {
    throw new ServiceError("Hermes Agent attachment SHA-256 is invalid.", 400);
  }
  return { plaintextBytes: bytes, sha256: normalizedSha256 };
}

function resolveHermesChatAgentAttachmentMaxBytes(env) {
  const configured = Number(env?.HERMES_CHAT_AGENT_ATTACHMENT_MAX_BYTES);
  if (
    Number.isSafeInteger(configured)
    && configured > MAX_CHAT_ATTACHMENT_PLAINTEXT_BYTES
    && configured <= ABSOLUTE_AGENT_ATTACHMENT_MAX_BYTES
  ) return configured;
  return DEFAULT_AGENT_ATTACHMENT_MAX_BYTES;
}

function requireR2SigningConfig(env) {
  const accountId = String(env.HERMES_CHAT_R2_ACCOUNT_ID || "").trim();
  const bucketName = String(env.HERMES_CHAT_R2_BUCKET_NAME || "notes").trim();
  const accessKeyId = String(env.HERMES_CHAT_R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.HERMES_CHAT_R2_SECRET_ACCESS_KEY || "").trim();
  if (
    !ACCOUNT_ID_PATTERN.test(accountId)
    || !BUCKET_NAME_PATTERN.test(bucketName)
    || !accessKeyId
    || !secretAccessKey
  ) {
    throw new ServiceError("Hermes chat R2 direct upload is not configured.", 503);
  }
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

function requireAgentUploader(agentId) {
  const normalized = String(agentId || "").trim();
  if (!normalized || normalized.length > 128) {
    throw new ServiceError("Invalid Hermes Agent id.", 400);
  }
  return `agent:${normalized}`;
}

function resolveTicketTtl(value, fallback) {
  const configured = Number(value);
  if (Number.isInteger(configured) && configured >= 60 && configured <= MAX_TICKET_TTL_SECONDS) {
    return configured;
  }
  return fallback;
}

function requireHeadBucket(bucket) {
  if (!bucket || typeof bucket.head !== "function") {
    throw new ServiceError("Hermes chat attachment storage is unavailable.", 503);
  }
  return bucket;
}

function requireHeadDeleteBucket(bucket) {
  if (!bucket || typeof bucket.head !== "function" || typeof bucket.delete !== "function") {
    throw new ServiceError("Hermes chat attachment storage is unavailable.", 503);
  }
  return bucket;
}

function normalizeMetadata(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value || {})) {
    result[String(key).toLowerCase()] = String(entry);
  }
  return result;
}

function hexToBase64(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function checksumHex(value) {
  if (!value) return "";
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return "";
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  HERMES_CHAT_PRIVATE_STORAGE,
  cancelHermesChatDirectUpload,
  confirmHermesChatDirectUpload,
  createHermesChatDirectDownloadTicket,
  createHermesChatDirectUploadTicket,
  resolveHermesChatAgentAttachmentMaxBytes,
};
