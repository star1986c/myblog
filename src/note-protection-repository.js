const KEYRING_ID = "notes-protection";
const KEYRING_VERSION = 1;
const KDF = "PBKDF2-SHA256";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLAINTEXT_FIELDS = [
  "password",
  "protectionPassword",
  "key",
  "dataKey",
  "title",
  "content",
];

class NoteProtectionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "NoteProtectionError";
    this.status = status;
  }
}

function byteLength(value) {
  const padding = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  return Math.floor(((value.length + padding) * 3) / 4) - padding;
}

function requireBase64Url(value, label, bytes) {
  if (
    typeof value !== "string"
    || !BASE64URL_PATTERN.test(value)
    || byteLength(value) !== bytes
  ) {
    throw new NoteProtectionError(`${label} is invalid.`, 400);
  }
  return value;
}

function normalizeKeyring(input) {
  const plaintextField = PLAINTEXT_FIELDS.find((field) => Object.hasOwn(input || {}, field));
  if (plaintextField) {
    throw new NoteProtectionError("Protection key API accepts wrapped key data only.", 400);
  }
  const keyring = {
    id: typeof input?.id === "string" ? input.id : KEYRING_ID,
    version: Number(input?.version),
    kdf: input?.kdf,
    iterations: Number(input?.iterations),
    salt: requireBase64Url(input?.salt, "Protection salt", 16),
    wrappedKey: requireBase64Url(input?.wrappedKey, "Wrapped protection key", 48),
    nonce: requireBase64Url(input?.nonce, "Protection key nonce", 12),
  };
  if (
    keyring.id !== KEYRING_ID
    || keyring.version !== KEYRING_VERSION
    || keyring.kdf !== KDF
    || !Number.isInteger(keyring.iterations)
    || keyring.iterations < 100_000
    || keyring.iterations > 2_000_000
  ) {
    throw new NoteProtectionError("Protection key metadata is invalid.", 400);
  }
  return keyring;
}

async function readNoteProtectionKeyring(db) {
  return await db
    .prepare(
      `SELECT id, version, kdf, iterations, salt,
              wrapped_key AS wrappedKey, nonce, revision,
              created_at AS createdAt, updated_at AS updatedAt
       FROM note_protection_keyrings
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(KEYRING_ID)
    .first();
}

async function createNoteProtectionKeyring(db, input) {
  const keyring = normalizeKeyring(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO note_protection_keyrings (
          id, version, kdf, iterations, salt, wrapped_key, nonce,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        keyring.id,
        keyring.version,
        keyring.kdf,
        keyring.iterations,
        keyring.salt,
        keyring.wrappedKey,
        keyring.nonce,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new NoteProtectionError("Protection password is already configured.", 409);
    }
    throw error;
  }
  return { ...keyring, revision: 1, createdAt: now, updatedAt: now };
}

async function updateNoteProtectionKeyring(db, input, expectedRevision) {
  const keyring = normalizeKeyring(input);
  const current = await readNoteProtectionKeyring(db);
  if (!current) throw new NoteProtectionError("Protection password is not configured.", 404);
  const revision = Number(current.revision);
  if (expectedRevision !== null && expectedRevision !== revision) {
    throw new NoteProtectionError("Protection password changed on another device.", 409);
  }
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE note_protection_keyrings
       SET version = ?, kdf = ?, iterations = ?, salt = ?, wrapped_key = ?, nonce = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .bind(
      keyring.version,
      keyring.kdf,
      keyring.iterations,
      keyring.salt,
      keyring.wrappedKey,
      keyring.nonce,
      now,
      KEYRING_ID,
      revision,
    )
    .run();
  if (!result.meta?.changes) {
    throw new NoteProtectionError("Protection password changed on another device.", 409);
  }
  return {
    ...keyring,
    revision: revision + 1,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}

export {
  NoteProtectionError,
  createNoteProtectionKeyring,
  normalizeKeyring,
  readNoteProtectionKeyring,
  updateNoteProtectionKeyring,
};
