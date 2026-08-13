const KEYRING_ID = "notes";
const KEYRING_VERSION = 1;
const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

class WorkspaceKeyError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "WorkspaceKeyError";
    this.status = status;
  }
}

function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new WorkspaceKeyError("Workspace key data is invalid.", 500);
  }
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requireWrappingSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new WorkspaceKeyError("Workspace encryption is not configured.", 503);
  }
  return secret;
}

async function importWrappingKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(requireWrappingSecret(secret)));
  return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function keyAdditionalData() {
  return encoder.encode(`ai-build-lab:workspace-key:${KEYRING_ID}:v${KEYRING_VERSION}`);
}

async function wrapDataKey(dataKey, secret) {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const wrappedKey = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: keyAdditionalData(),
      tagLength: 128,
    },
    await importWrappingKey(secret),
    dataKey,
  );
  return {
    wrappedKey: bytesToBase64Url(wrappedKey),
    nonce: bytesToBase64Url(nonce),
  };
}

async function unwrapDataKey(row, secret) {
  if (Number(row?.version) !== KEYRING_VERSION) {
    throw new WorkspaceKeyError("Workspace key version is not supported.", 500);
  }
  const nonce = base64UrlToBytes(row.nonce);
  const wrappedKey = base64UrlToBytes(row.wrappedKey);
  if (nonce.byteLength !== NONCE_BYTES || wrappedKey.byteLength !== DATA_KEY_BYTES + 16) {
    throw new WorkspaceKeyError("Workspace key data is invalid.", 500);
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: keyAdditionalData(),
        tagLength: 128,
      },
      await importWrappingKey(secret),
      wrappedKey,
    );
    const dataKey = new Uint8Array(plaintext);
    if (dataKey.byteLength !== DATA_KEY_BYTES) throw new Error("Invalid key length");
    return dataKey;
  } catch {
    throw new WorkspaceKeyError("Workspace key could not be recovered.", 503);
  }
}

async function readKeyring(db) {
  return await db
    .prepare(
      `SELECT id, version, wrapped_key AS wrappedKey, nonce, created_at AS createdAt, updated_at AS updatedAt
       FROM workspace_keyrings
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(KEYRING_ID)
    .first();
}

async function createKeyring(db, secret) {
  const dataKey = crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
  const wrapped = await wrapDataKey(dataKey, secret);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO workspace_keyrings (id, version, wrapped_key, nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(KEYRING_ID, KEYRING_VERSION, wrapped.wrappedKey, wrapped.nonce, now, now)
      .run();
    return dataKey;
  } catch (error) {
    if (!String(error?.message || error).includes("UNIQUE")) throw error;
    const existing = await readKeyring(db);
    if (!existing) throw error;
    return await unwrapDataKey(existing, secret);
  }
}

async function readOrCreateWorkspaceDataKey(db, secret) {
  requireWrappingSecret(secret);
  const keyring = await readKeyring(db);
  const dataKey = keyring
    ? await unwrapDataKey(keyring, secret)
    : await createKeyring(db, secret);
  return {
    version: KEYRING_VERSION,
    key: bytesToBase64Url(dataKey),
  };
}

export {
  KEYRING_ID,
  KEYRING_VERSION,
  WorkspaceKeyError,
  readOrCreateWorkspaceDataKey,
};
