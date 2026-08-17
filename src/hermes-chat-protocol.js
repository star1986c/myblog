import { ServiceError } from "./blog-repository.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CHAT_PROTOCOL_VERSION = 1;
const CHAT_TICKET_MAX_AGE_SECONDS = 90;
const CHAT_MESSAGE_MAX_BYTES = 64 * 1024;
const CHAT_CIPHERTEXT_MAX_LENGTH = 56 * 1024;
const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

async function createHermesChatTicket({
  secret,
  username,
  spaceId,
  now = Date.now(),
  maxAgeSeconds = CHAT_TICKET_MAX_AGE_SECONDS,
}) {
  if (!secret) throw new ServiceError("Hermes chat authentication is unavailable.", 503);
  const normalizedSpaceId = normalizeHermesChatSpaceId(spaceId);
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    sub: "hermes-chat-client",
    username: String(username || ""),
    spaceId: normalizedSpaceId,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + Math.min(Math.max(Number(maxAgeSeconds) || 1, 1), 300),
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signaturePart = bytesToBase64Url(await hmacSha256(secret, payloadPart));
  return `${payloadPart}.${signaturePart}`;
}

async function verifyHermesChatTicket({ token, secret, now = Date.now() }) {
  if (!token || !secret) return null;
  const [payloadPart, signaturePart, extra] = String(token).split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) return null;

  let expected;
  let payload;
  try {
    expected = base64UrlToBytes(signaturePart);
    payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadPart)));
  } catch {
    return null;
  }
  const actual = await hmacSha256(secret, payloadPart);
  if (!constantTimeEqual(actual, expected)) return null;
  if (payload?.sub !== "hermes-chat-client") return null;
  if (typeof payload.username !== "string" || !payload.username) return null;
  if (!isHermesChatSpaceId(payload.spaceId)) return null;
  if (!MESSAGE_ID_PATTERN.test(payload.jti || "")) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}

function normalizeHermesChatSpaceId(value) {
  const spaceId = String(value || "default").trim().toLowerCase();
  if (!isHermesChatSpaceId(spaceId)) {
    throw new ServiceError("Invalid Hermes chat space.", 400);
  }
  return spaceId;
}

function isHermesChatSpaceId(value) {
  return typeof value === "string" && SPACE_ID_PATTERN.test(value);
}

function hasConnectedHermesChatAgent(existingConnections) {
  return Array.from(existingConnections || []).length > 0;
}

function readBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match ? match[1] : "";
}

async function constantTimeSecretEqual(left, right) {
  const actual = encoder.encode(String(left || ""));
  const expected = encoder.encode(String(right || ""));
  const leftDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", actual));
  const rightDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", expected));
  return actual.byteLength > 0 && expected.byteLength > 0 && constantTimeEqual(leftDigest, rightDigest);
}

function parseHermesChatFrame(message) {
  if (typeof message !== "string" || encoder.encode(message).byteLength > CHAT_MESSAGE_MAX_BYTES) {
    throw new ServiceError("Hermes chat frame is too large.", 400);
  }
  let frame;
  try {
    frame = JSON.parse(message);
  } catch {
    throw new ServiceError("Hermes chat frame must be valid JSON.", 400);
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new ServiceError("Invalid Hermes chat frame.", 400);
  }
  return frame;
}

function validateHermesChatMessage(frame, expectedSender) {
  if (frame.v !== CHAT_PROTOCOL_VERSION || frame.type !== "message") {
    throw new ServiceError("Unsupported Hermes chat message.", 400);
  }
  if (!MESSAGE_ID_PATTERN.test(frame.id || "")) {
    throw new ServiceError("Invalid Hermes chat message id.", 400);
  }
  if (frame.sender !== expectedSender || !["client", "agent"].includes(frame.sender)) {
    throw new ServiceError("Invalid Hermes chat sender.", 403);
  }
  if (!Number.isSafeInteger(frame.sentAt) || frame.sentAt < 0) {
    throw new ServiceError("Invalid Hermes chat timestamp.", 400);
  }
  const encrypted = frame.encrypted;
  if (!encrypted || encrypted.alg !== "A256GCM") {
    throw new ServiceError("Unsupported Hermes chat encryption.", 400);
  }
  if (
    typeof encrypted.nonce !== "string" ||
    encrypted.nonce.length < 16 ||
    encrypted.nonce.length > 32 ||
    !BASE64_URL_PATTERN.test(encrypted.nonce)
  ) {
    throw new ServiceError("Invalid Hermes chat nonce.", 400);
  }
  if (
    typeof encrypted.ciphertext !== "string" ||
    encrypted.ciphertext.length < 1 ||
    encrypted.ciphertext.length > CHAT_CIPHERTEXT_MAX_LENGTH ||
    !BASE64_URL_PATTERN.test(encrypted.ciphertext)
  ) {
    throw new ServiceError("Invalid Hermes chat ciphertext.", 400);
  }
  return {
    v: CHAT_PROTOCOL_VERSION,
    type: "message",
    id: frame.id,
    sender: frame.sender,
    sentAt: frame.sentAt,
    encrypted: {
      alg: "A256GCM",
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    },
  };
}

function validateHermesChatEdit(frame, senderRole) {
  if (senderRole !== "agent") {
    throw new ServiceError("Only Hermes agents may edit messages.", 403);
  }
  if (frame?.v !== CHAT_PROTOCOL_VERSION || frame?.type !== "edit") {
    throw new ServiceError("Invalid Hermes chat edit.", 400);
  }
  if (!Number.isSafeInteger(frame.targetSeq) || frame.targetSeq < 1) {
    throw new ServiceError("Invalid Hermes chat edit target sequence.", 400);
  }
  if (typeof frame.final !== "boolean") {
    throw new ServiceError("Invalid Hermes chat edit final flag.", 400);
  }
  return {
    v: CHAT_PROTOCOL_VERSION,
    type: "edit",
    targetSeq: frame.targetSeq,
    final: frame.final,
    message: validateHermesChatMessage(frame.message, "agent"),
  };
}

function buildHermesChatDeliveryFrame(storedEvent, sequence, replayed = false) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ServiceError("Invalid Hermes chat delivery sequence.", 500);
  }
  const replay = replayed ? { replayed: true } : {};
  if (storedEvent?.type === "edit") {
    return { ...storedEvent, seq: sequence, ...replay };
  }
  return {
    v: CHAT_PROTOCOL_VERSION,
    type: "message",
    seq: sequence,
    message: storedEvent,
    ...replay,
  };
}

function validateHermesChatReceipt(frame, receiverRole) {
  if (receiverRole !== "agent") {
    throw new ServiceError("Only Hermes agents may acknowledge consumed messages.", 403);
  }
  if (frame?.v !== CHAT_PROTOCOL_VERSION || frame?.type !== "received") {
    throw new ServiceError("Invalid Hermes chat receipt.", 400);
  }
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) {
    throw new ServiceError("Invalid Hermes chat receipt sequence.", 400);
  }
  return frame.seq;
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function constantTimeEqual(left, right) {
  const maximum = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export {
  CHAT_PROTOCOL_VERSION,
  buildHermesChatDeliveryFrame,
  constantTimeSecretEqual,
  createHermesChatTicket,
  hasConnectedHermesChatAgent,
  normalizeHermesChatSpaceId,
  parseHermesChatFrame,
  readBearerToken,
  validateHermesChatMessage,
  validateHermesChatEdit,
  validateHermesChatReceipt,
  verifyHermesChatTicket,
};
