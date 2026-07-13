const VAULT_ID = "default";
const VAULT_VERSION = 1;
const KDF_NAME = "PBKDF2-SHA-256";
const MIN_KDF_ITERATIONS = 100_000;
const MAX_KDF_ITERATIONS = 2_000_000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_ENTRY_CIPHERTEXT_BYTES = 65_536;
const PLAINTEXT_FIELDS = ["masterPassword", "password", "title", "username", "url", "notes"];

const VAULT_COLUMNS = [
  "id",
  "version",
  "kdf",
  "iterations",
  "salt",
  "wrapped_key AS wrappedKey",
  "wrap_nonce AS wrapNonce",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

const ENTRY_COLUMNS = [
  "id",
  "version",
  "ciphertext",
  "nonce",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

class PasswordVaultError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "PasswordVaultError";
    this.status = status;
  }
}

function rejectPlaintextFields(input) {
  const field = PLAINTEXT_FIELDS.find((name) => Object.hasOwn(input || {}, name));
  if (field) {
    throw new PasswordVaultError("Password vault API accepts encrypted data only.", 400);
  }
}

function validateBase64Url(value, label, { minBytes, maxBytes }) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new PasswordVaultError(`${label} is invalid.`, 400);
  }
  const padding = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const byteLength = Math.floor(((value.length + padding) * 3) / 4) - padding;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new PasswordVaultError(`${label} is invalid.`, 400);
  }
  return value;
}

function normalizePasswordVault(input) {
  rejectPlaintextFields(input);
  const vault = {
    id: typeof input?.id === "string" ? input.id : VAULT_ID,
    version: Number(input?.version),
    kdf: typeof input?.kdf === "string" ? input.kdf : "",
    iterations: Number(input?.iterations),
    salt: validateBase64Url(input?.salt, "Vault salt", { minBytes: 16, maxBytes: 16 }),
    wrappedKey: validateBase64Url(input?.wrappedKey, "Wrapped vault key", {
      minBytes: 48,
      maxBytes: 48,
    }),
    wrapNonce: validateBase64Url(input?.wrapNonce, "Vault nonce", {
      minBytes: 12,
      maxBytes: 12,
    }),
  };
  if (vault.id !== VAULT_ID || vault.version !== VAULT_VERSION || vault.kdf !== KDF_NAME) {
    throw new PasswordVaultError("Password vault format is not supported.", 400);
  }
  if (
    !Number.isInteger(vault.iterations) ||
    vault.iterations < MIN_KDF_ITERATIONS ||
    vault.iterations > MAX_KDF_ITERATIONS
  ) {
    throw new PasswordVaultError("Password vault key settings are invalid.", 400);
  }
  return vault;
}

function normalizePasswordVaultEntry(input, expectedId = "") {
  rejectPlaintextFields(input);
  const id = expectedId || (typeof input?.id === "string" ? input.id : "");
  const entry = {
    id,
    version: Number(input?.version),
    ciphertext: validateBase64Url(input?.ciphertext, "Encrypted password entry", {
      minBytes: 17,
      maxBytes: MAX_ENTRY_CIPHERTEXT_BYTES,
    }),
    nonce: validateBase64Url(input?.nonce, "Password entry nonce", {
      minBytes: 12,
      maxBytes: 12,
    }),
  };
  if (!ENTRY_ID_PATTERN.test(entry.id) || entry.version !== VAULT_VERSION) {
    throw new PasswordVaultError("Encrypted password entry metadata is invalid.", 400);
  }
  if (input?.id && input.id !== entry.id) {
    throw new PasswordVaultError("Password entry ID does not match the request path.", 400);
  }
  return entry;
}

async function getPasswordVault(db) {
  return await db
    .prepare(`SELECT ${VAULT_COLUMNS} FROM password_vaults WHERE id = ? LIMIT 1`)
    .bind(VAULT_ID)
    .first();
}

async function listPasswordVaultEntries(db) {
  const result = await db
    .prepare(
      `SELECT ${ENTRY_COLUMNS}
       FROM password_vault_entries
       WHERE vault_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .bind(VAULT_ID)
    .all();
  return result.results || [];
}

async function readPasswordVault(db) {
  const vault = await getPasswordVault(db);
  const entries = vault ? await listPasswordVaultEntries(db) : [];
  return { vault, entries };
}

async function createPasswordVault(db, input) {
  const vault = normalizePasswordVault(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO password_vaults (
          id, version, kdf, iterations, salt, wrapped_key, wrap_nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        vault.id,
        vault.version,
        vault.kdf,
        vault.iterations,
        vault.salt,
        vault.wrappedKey,
        vault.wrapNonce,
        now,
        now,
      )
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new PasswordVaultError("Password vault is already configured.", 409);
    }
    throw error;
  }
  return { ...vault, createdAt: now, updatedAt: now };
}

async function updatePasswordVault(db, input) {
  const vault = normalizePasswordVault(input);
  if (!(await getPasswordVault(db))) {
    throw new PasswordVaultError("Password vault is not configured.", 404);
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE password_vaults
       SET version = ?, kdf = ?, iterations = ?, salt = ?, wrapped_key = ?, wrap_nonce = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      vault.version,
      vault.kdf,
      vault.iterations,
      vault.salt,
      vault.wrappedKey,
      vault.wrapNonce,
      now,
      vault.id,
    )
    .run();
  return { ...vault, updatedAt: now };
}

async function createPasswordVaultEntry(db, input) {
  if (!(await getPasswordVault(db))) {
    throw new PasswordVaultError("Password vault is not configured.", 409);
  }
  const entry = normalizePasswordVaultEntry(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO password_vault_entries (
          id, vault_id, version, ciphertext, nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(entry.id, VAULT_ID, entry.version, entry.ciphertext, entry.nonce, now, now)
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new PasswordVaultError("Password entry already exists.", 409);
    }
    throw error;
  }
  return { ...entry, createdAt: now, updatedAt: now };
}

async function updatePasswordVaultEntry(db, id, input) {
  const entry = normalizePasswordVaultEntry(input, id);
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE password_vault_entries
       SET version = ?, ciphertext = ?, nonce = ?, updated_at = ?
       WHERE id = ? AND vault_id = ?`,
    )
    .bind(entry.version, entry.ciphertext, entry.nonce, now, entry.id, VAULT_ID)
    .run();
  return { ...entry, updatedAt: now };
}

async function deletePasswordVaultEntry(db, id) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new PasswordVaultError("Password entry ID is invalid.", 400);
  }
  await db
    .prepare("DELETE FROM password_vault_entries WHERE id = ? AND vault_id = ?")
    .bind(id, VAULT_ID)
    .run();
}

export {
  PasswordVaultError,
  createPasswordVault,
  createPasswordVaultEntry,
  deletePasswordVaultEntry,
  getPasswordVault,
  listPasswordVaultEntries,
  normalizePasswordVault,
  normalizePasswordVaultEntry,
  readPasswordVault,
  updatePasswordVault,
  updatePasswordVaultEntry,
};
