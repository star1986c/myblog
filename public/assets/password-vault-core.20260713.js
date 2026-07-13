const VAULT_VERSION = 1;
const VAULT_ID = "default";
const KDF_NAME = "PBKDF2-SHA-256";
const KDF_ITERATIONS = 600_000;
const MIN_KDF_ITERATIONS = 100_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const MIN_MASTER_PASSWORD_LENGTH = 14;
const MAX_MASTER_PASSWORD_LENGTH = 256;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_ENTRY_CIPHERTEXT_BYTES = 65_536;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requireCrypto(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("This browser does not support the Web Crypto features required by the vault.");
  }
  return cryptoImpl;
}

function validateMasterPassword(password) {
  if (typeof password !== "string" || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(`Master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_MASTER_PASSWORD_LENGTH) {
    throw new Error(`Master password must be at most ${MAX_MASTER_PASSWORD_LENGTH} characters.`);
  }
  return password;
}

function randomBytes(length, cryptoImpl = globalThis.crypto) {
  const bytes = new Uint8Array(length);
  requireCrypto(cryptoImpl).getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Encrypted vault data is invalid.");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Encrypted vault data is invalid.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function normalizeVaultConfig(input) {
  const config = {
    id: typeof input?.id === "string" ? input.id : VAULT_ID,
    version: Number(input?.version),
    kdf: typeof input?.kdf === "string" ? input.kdf : "",
    iterations: Number(input?.iterations),
    salt: typeof input?.salt === "string" ? input.salt : "",
    wrappedKey: typeof input?.wrappedKey === "string" ? input.wrappedKey : "",
    wrapNonce: typeof input?.wrapNonce === "string" ? input.wrapNonce : "",
  };

  if (config.id !== VAULT_ID || config.version !== VAULT_VERSION || config.kdf !== KDF_NAME) {
    throw new Error("This password vault format is not supported.");
  }
  if (
    !Number.isInteger(config.iterations) ||
    config.iterations < MIN_KDF_ITERATIONS ||
    config.iterations > MAX_KDF_ITERATIONS
  ) {
    throw new Error("Password vault key settings are invalid.");
  }
  if (base64UrlToBytes(config.salt).byteLength !== SALT_BYTES) {
    throw new Error("Password vault salt is invalid.");
  }
  if (base64UrlToBytes(config.wrapNonce).byteLength !== NONCE_BYTES) {
    throw new Error("Password vault nonce is invalid.");
  }
  if (base64UrlToBytes(config.wrappedKey).byteLength !== KEY_BYTES + 16) {
    throw new Error("Password vault wrapped key is invalid.");
  }
  return config;
}

async function deriveKeyEncryptionKey(password, config, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const normalized = normalizeVaultConfig(config);
  const material = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return await cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(normalized.salt),
      iterations: normalized.iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function keyAdditionalData(config) {
  return encoder.encode(`ai-build-lab:vault-key:${config.id}:v${config.version}`);
}

function entryAdditionalData(id, version) {
  return encoder.encode(`ai-build-lab:vault-entry:${id}:v${version}`);
}

async function importDataKey(rawKey, cryptoImpl = globalThis.crypto) {
  return await requireCrypto(cryptoImpl).subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function createPasswordVault(masterPassword, cryptoImpl = globalThis.crypto) {
  validateMasterPassword(masterPassword);
  const cryptoApi = requireCrypto(cryptoImpl);
  const rawKey = randomBytes(KEY_BYTES, cryptoApi);
  const wrapNonce = randomBytes(NONCE_BYTES, cryptoApi);
  const config = {
    id: VAULT_ID,
    version: VAULT_VERSION,
    kdf: KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64Url(randomBytes(SALT_BYTES, cryptoApi)),
    wrappedKey: "pending",
    wrapNonce: bytesToBase64Url(wrapNonce),
  };
  const keyEncryptionKey = await deriveKeyEncryptionKey(masterPassword, {
    ...config,
    wrappedKey: bytesToBase64Url(new Uint8Array(KEY_BYTES + 16)),
  }, cryptoApi);
  const wrappedKey = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: wrapNonce,
      additionalData: keyAdditionalData(config),
      tagLength: 128,
    },
    keyEncryptionKey,
    rawKey,
  );
  config.wrappedKey = bytesToBase64Url(wrappedKey);
  return {
    vault: normalizeVaultConfig(config),
    dataKey: await importDataKey(rawKey, cryptoApi),
  };
}

async function unwrapDataKey(masterPassword, vault, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const config = normalizeVaultConfig(vault);
  const keyEncryptionKey = await deriveKeyEncryptionKey(masterPassword, config, cryptoApi);
  const rawKey = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(config.wrapNonce),
      additionalData: keyAdditionalData(config),
      tagLength: 128,
    },
    keyEncryptionKey,
    base64UrlToBytes(config.wrappedKey),
  );
  if (rawKey.byteLength !== KEY_BYTES) {
    throw new Error("Password vault key is invalid.");
  }
  return new Uint8Array(rawKey);
}

async function unlockPasswordVault(masterPassword, vault, cryptoImpl = globalThis.crypto) {
  const rawKey = await unwrapDataKey(masterPassword, vault, cryptoImpl);
  return await importDataKey(rawKey, cryptoImpl);
}

async function changePasswordVaultMasterPassword(
  currentPassword,
  nextPassword,
  vault,
  cryptoImpl = globalThis.crypto,
) {
  validateMasterPassword(nextPassword);
  const cryptoApi = requireCrypto(cryptoImpl);
  const rawKey = await unwrapDataKey(currentPassword, vault, cryptoApi);
  const wrapNonce = randomBytes(NONCE_BYTES, cryptoApi);
  const nextVault = {
    id: VAULT_ID,
    version: VAULT_VERSION,
    kdf: KDF_NAME,
    iterations: KDF_ITERATIONS,
    salt: bytesToBase64Url(randomBytes(SALT_BYTES, cryptoApi)),
    wrappedKey: bytesToBase64Url(new Uint8Array(KEY_BYTES + 16)),
    wrapNonce: bytesToBase64Url(wrapNonce),
  };
  const nextKeyEncryptionKey = await deriveKeyEncryptionKey(nextPassword, nextVault, cryptoApi);
  const wrappedKey = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: wrapNonce,
      additionalData: keyAdditionalData(nextVault),
      tagLength: 128,
    },
    nextKeyEncryptionKey,
    rawKey,
  );
  nextVault.wrappedKey = bytesToBase64Url(wrappedKey);
  return normalizeVaultConfig(nextVault);
}

function cleanField(value, label, maxLength, { required = false } = {}) {
  const text = typeof value === "string" ? value : "";
  const normalized = label === "Password" || label === "Notes" ? text : text.trim();
  if (required && !normalized) {
    throw new Error(`${label} is required.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function normalizePasswordVaultEntry(input) {
  return {
    title: cleanField(input?.title, "Name", 200, { required: true }),
    username: cleanField(input?.username, "Username", 320),
    password: cleanField(input?.password, "Password", 1024, { required: true }),
    url: cleanField(input?.url, "URL", 2048),
    notes: cleanField(input?.notes, "Notes", 5000),
  };
}

function validateEntryEnvelope(input) {
  const envelope = {
    id: typeof input?.id === "string" ? input.id : "",
    version: Number(input?.version),
    ciphertext: typeof input?.ciphertext === "string" ? input.ciphertext : "",
    nonce: typeof input?.nonce === "string" ? input.nonce : "",
  };
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(envelope.id) || envelope.version !== VAULT_VERSION) {
    throw new Error("Encrypted password entry metadata is invalid.");
  }
  if (base64UrlToBytes(envelope.nonce).byteLength !== NONCE_BYTES) {
    throw new Error("Encrypted password entry nonce is invalid.");
  }
  const ciphertextBytes = base64UrlToBytes(envelope.ciphertext);
  if (ciphertextBytes.byteLength < 17 || ciphertextBytes.byteLength > MAX_ENTRY_CIPHERTEXT_BYTES) {
    throw new Error("Encrypted password entry payload is invalid.");
  }
  return envelope;
}

async function encryptPasswordVaultEntry(dataKey, id, input, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const entry = normalizePasswordVaultEntry(input);
  const nonce = randomBytes(NONCE_BYTES, cryptoApi);
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: entryAdditionalData(id, VAULT_VERSION),
      tagLength: 128,
    },
    dataKey,
    encoder.encode(JSON.stringify(entry)),
  );
  return validateEntryEnvelope({
    id,
    version: VAULT_VERSION,
    ciphertext: bytesToBase64Url(ciphertext),
    nonce: bytesToBase64Url(nonce),
  });
}

async function decryptPasswordVaultEntry(dataKey, input, cryptoImpl = globalThis.crypto) {
  const cryptoApi = requireCrypto(cryptoImpl);
  const envelope = validateEntryEnvelope(input);
  const plaintext = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(envelope.nonce),
      additionalData: entryAdditionalData(envelope.id, envelope.version),
      tagLength: 128,
    },
    dataKey,
    base64UrlToBytes(envelope.ciphertext),
  );
  let parsed;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error("Encrypted password entry could not be read.");
  }
  return normalizePasswordVaultEntry(parsed);
}

export {
  KDF_ITERATIONS,
  KDF_NAME,
  MIN_MASTER_PASSWORD_LENGTH,
  VAULT_ID,
  VAULT_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  changePasswordVaultMasterPassword,
  createPasswordVault,
  decryptPasswordVaultEntry,
  encryptPasswordVaultEntry,
  normalizePasswordVaultEntry,
  normalizeVaultConfig,
  unlockPasswordVault,
  validateMasterPassword,
};
