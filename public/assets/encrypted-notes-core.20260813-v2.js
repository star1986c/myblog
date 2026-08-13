const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const DATA_KEY_BYTES = 32;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 500_000;
const MAX_CIPHERTEXT_BYTES = 2_100_000;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Encrypted data is invalid.");
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requireCrypto(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("This browser does not support the Web Crypto features required by private notes.");
  }
  return cryptoImpl;
}

function normalizeEncryptedNote(input = {}) {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const content = typeof input.content === "string" ? input.content.slice(0, MAX_CONTENT_LENGTH) : "";
  return {
    title: title || "无标题笔记",
    content,
  };
}

function noteAdditionalData(id, version) {
  return encoder.encode(`ai-build-lab:encrypted-note:${id}:v${version}`);
}

function validateEncryptedNoteEnvelope(input) {
  const envelope = {
    id: typeof input?.id === "string" ? input.id : "",
    version: Number(input?.version),
    ciphertext: typeof input?.ciphertext === "string" ? input.ciphertext : "",
    nonce: typeof input?.nonce === "string" ? input.nonce : "",
  };
  if (!ENTRY_ID_PATTERN.test(envelope.id) || envelope.version !== ENVELOPE_VERSION) {
    throw new Error("Encrypted note metadata is invalid.");
  }
  if (base64UrlToBytes(envelope.nonce).byteLength !== NONCE_BYTES) {
    throw new Error("Encrypted note nonce is invalid.");
  }
  const ciphertextBytes = base64UrlToBytes(envelope.ciphertext);
  if (ciphertextBytes.byteLength < 17 || ciphertextBytes.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error("Encrypted note payload is invalid.");
  }
  return envelope;
}

async function encryptNote(dataKey, id, input, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const note = normalizeEncryptedNote(input);
  const nonce = new Uint8Array(NONCE_BYTES);
  cryptoApi.getRandomValues(nonce);
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: noteAdditionalData(id, ENVELOPE_VERSION),
      tagLength: 128,
    },
    dataKey,
    encoder.encode(JSON.stringify(note)),
  );
  return validateEncryptedNoteEnvelope({
    id,
    version: ENVELOPE_VERSION,
    ciphertext: bytesToBase64Url(ciphertext),
    nonce: bytesToBase64Url(nonce),
  });
}

async function importNoteDataKey(value, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const rawKey = base64UrlToBytes(value);
  if (rawKey.byteLength !== DATA_KEY_BYTES) {
    throw new Error("Workspace data key is invalid.");
  }
  return await cryptoApi.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function decryptNote(dataKey, input, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const envelope = validateEncryptedNoteEnvelope(input);
  const plaintext = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.nonce),
      additionalData: noteAdditionalData(envelope.id, envelope.version),
      tagLength: 128,
    },
    dataKey,
    base64UrlToBytes(envelope.ciphertext),
  );
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("Encrypted note could not be read.");
  }
  return normalizeEncryptedNote(parsed);
}

export {
  MAX_CONTENT_LENGTH,
  MAX_TITLE_LENGTH,
  decryptNote,
  encryptNote,
  importNoteDataKey,
  normalizeEncryptedNote,
  validateEncryptedNoteEnvelope,
};
