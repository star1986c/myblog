const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const DATA_KEY_BYTES = 32;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 500_000;
const MAX_CIPHERTEXT_BYTES = 2_100_000;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const PROTECTION_ITERATIONS = 310_000;
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

function validateProtectedBody(input) {
  const body = {
    version: Number(input?.version),
    ciphertext: typeof input?.ciphertext === "string" ? input.ciphertext : "",
    nonce: typeof input?.nonce === "string" ? input.nonce : "",
  };
  if (
    body.version !== 1
    || base64UrlToBytes(body.nonce).byteLength !== NONCE_BYTES
    || base64UrlToBytes(body.ciphertext).byteLength < 17
  ) throw new Error("Protected note body is invalid.");
  return body;
}

function normalizeEncryptedNote(input = {}) {
  const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const content = typeof input.content === "string" ? input.content.slice(0, MAX_CONTENT_LENGTH) : "";
  const note = { title: title || "无标题笔记", content: input?.protectedContent ? "" : content };
  if (input?.protectedContent) note.protectedContent = validateProtectedBody(input.protectedContent);
  return note;
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
    isLocked: input?.isLocked === true,
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
  const nonce = cryptoApi.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: noteAdditionalData(id, 1), tagLength: 128 },
    dataKey,
    encoder.encode(JSON.stringify(note)),
  );
  return validateEncryptedNoteEnvelope({
    id,
    version: 1,
    ciphertext: bytesToBase64Url(ciphertext),
    nonce: bytesToBase64Url(nonce),
    isLocked: Boolean(note.protectedContent),
  });
}

async function importNoteDataKey(value, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const rawKey = base64UrlToBytes(value);
  if (rawKey.byteLength !== DATA_KEY_BYTES) throw new Error("Workspace data key is invalid.");
  return await cryptoApi.subtle.importKey(
    "raw", rawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
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
  try {
    return normalizeEncryptedNote(JSON.parse(decoder.decode(plaintext)));
  } catch {
    throw new Error("Encrypted note could not be read.");
  }
}

async function deriveProtectionKey(password, salt, iterations, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) {
    throw new Error("Protection key metadata is invalid.");
  }
  const material = await cryptoApi.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"],
  );
  return await cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function createProtectionKeyring(password, cryptoImpl = globalThis.crypto) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("保护密码至少需要 12 个字符。");
  }
  const cryptoApi = requireCrypto(cryptoImpl);
  const rawKey = cryptoApi.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const nonce = cryptoApi.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrappedKey = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode("ai-build-lab:note-protection-key:v1"),
      tagLength: 128,
    },
    await deriveProtectionKey(password, salt, PROTECTION_ITERATIONS, cryptoApi),
    rawKey,
  );
  return {
    key: await cryptoApi.subtle.importKey(
      "raw", rawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    ),
    payload: {
      id: "notes-protection",
      version: 1,
      kdf: "PBKDF2-SHA256",
      iterations: PROTECTION_ITERATIONS,
      salt: bytesToBase64Url(salt),
      wrappedKey: bytesToBase64Url(wrappedKey),
      nonce: bytesToBase64Url(nonce),
    },
  };
}

async function unlockProtectionKeyring(keyring, password, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  if (keyring?.id !== "notes-protection" || Number(keyring?.version) !== 1
    || keyring?.kdf !== "PBKDF2-SHA256") {
    throw new Error("Protection key metadata is invalid.");
  }
  const salt = base64UrlToBytes(keyring.salt);
  const nonce = base64UrlToBytes(keyring.nonce);
  const wrappedKey = base64UrlToBytes(keyring.wrappedKey);
  if (salt.byteLength !== 16 || nonce.byteLength !== 12 || wrappedKey.byteLength !== 48) {
    throw new Error("Protection key metadata is invalid.");
  }
  try {
    const rawKey = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encoder.encode("ai-build-lab:note-protection-key:v1"),
        tagLength: 128,
      },
      await deriveProtectionKey(password, salt, Number(keyring.iterations), cryptoApi),
      wrappedKey,
    );
    return await cryptoApi.subtle.importKey(
      "raw", rawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
    );
  } catch {
    throw new Error("保护密码不正确。");
  }
}

function protectedBodyAdditionalData(id) {
  return encoder.encode(`ai-build-lab:protected-note-body:${id}:v1`);
}

async function encryptProtectedBody(key, id, content, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const nonce = cryptoApi.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: protectedBodyAdditionalData(id),
      tagLength: 128,
    },
    key,
    encoder.encode(String(content || "").slice(0, MAX_CONTENT_LENGTH)),
  );
  return { version: 1, ciphertext: bytesToBase64Url(ciphertext), nonce: bytesToBase64Url(nonce) };
}

async function decryptProtectedBody(key, id, input, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const body = validateProtectedBody(input);
  try {
    return decoder.decode(await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(body.nonce),
        additionalData: protectedBodyAdditionalData(id),
        tagLength: 128,
      },
      key,
      base64UrlToBytes(body.ciphertext),
    ));
  } catch {
    throw new Error("无法解密受保护正文。");
  }
}

export {
  MAX_CONTENT_LENGTH,
  MAX_TITLE_LENGTH,
  createProtectionKeyring,
  decryptNote,
  decryptProtectedBody,
  encryptNote,
  encryptProtectedBody,
  importNoteDataKey,
  normalizeEncryptedNote,
  unlockProtectionKeyring,
  validateEncryptedNoteEnvelope,
};
