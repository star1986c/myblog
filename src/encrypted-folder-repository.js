const KEYRING_ID = "notes";
const ENVELOPE_VERSION = 1;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT_BYTES = 16_384;
const PLAINTEXT_FIELDS = ["name", "title", "content", "password", "username", "notes"];

const FOLDER_COLUMNS = [
  "id",
  "version",
  "revision",
  "ciphertext",
  "nonce",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

class EncryptedFolderError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "EncryptedFolderError";
    this.status = status;
  }
}

function rejectPlaintextFields(input) {
  const field = PLAINTEXT_FIELDS.find((name) => Object.hasOwn(input || {}, name));
  if (field) {
    throw new EncryptedFolderError("Private folder API accepts encrypted data only.", 400);
  }
}

function validateBase64Url(value, label, { minBytes, maxBytes }) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new EncryptedFolderError(`${label} is invalid.`, 400);
  }
  const padding = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const byteLength = Math.floor(((value.length + padding) * 3) / 4) - padding;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new EncryptedFolderError(`${label} is invalid.`, 400);
  }
  return value;
}

function normalizeEncryptedFolderEnvelope(input, expectedId = "") {
  rejectPlaintextFields(input);
  const id = expectedId || (typeof input?.id === "string" ? input.id : "");
  const folder = {
    id,
    version: Number(input?.version),
    ciphertext: validateBase64Url(input?.ciphertext, "Encrypted folder", {
      minBytes: 17,
      maxBytes: MAX_CIPHERTEXT_BYTES,
    }),
    nonce: validateBase64Url(input?.nonce, "Encrypted folder nonce", {
      minBytes: 12,
      maxBytes: 12,
    }),
  };
  if (!ENTRY_ID_PATTERN.test(folder.id) || folder.version !== ENVELOPE_VERSION) {
    throw new EncryptedFolderError("Encrypted folder metadata is invalid.", 400);
  }
  if (input?.id && input.id !== folder.id) {
    throw new EncryptedFolderError("Encrypted folder ID does not match the request path.", 400);
  }
  return folder;
}

async function requireWorkspaceKey(db) {
  const keyring = await db
    .prepare("SELECT id FROM workspace_keyrings WHERE id = ? LIMIT 1")
    .bind(KEYRING_ID)
    .first();
  if (!keyring) {
    throw new EncryptedFolderError("Encrypted workspace key is not configured.", 409);
  }
}

async function listEncryptedFolders(db) {
  const result = await db
    .prepare(
      `SELECT ${FOLDER_COLUMNS}
       FROM encrypted_note_folders
       WHERE keyring_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(KEYRING_ID)
    .all();
  return result.results || [];
}

async function createEncryptedFolder(db, input) {
  await requireWorkspaceKey(db);
  const folder = normalizeEncryptedFolderEnvelope(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO encrypted_note_folders (
          id, keyring_id, version, ciphertext, nonce, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(folder.id, KEYRING_ID, folder.version, folder.ciphertext, folder.nonce, now, now)
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new EncryptedFolderError("Encrypted folder already exists.", 409);
    }
    throw error;
  }
  return { ...folder, revision: 1, createdAt: now, updatedAt: now };
}

async function readEncryptedFolderState(db, id) {
  return await db
    .prepare(
      `SELECT revision
       FROM encrypted_note_folders
       WHERE id = ? AND keyring_id = ?
       LIMIT 1`,
    )
    .bind(id, KEYRING_ID)
    .first();
}

function requireCurrentRevision(state, expectedRevision) {
  if (!state) {
    throw new EncryptedFolderError("Encrypted folder not found.", 404);
  }
  const revision = Number(state.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new EncryptedFolderError("Encrypted folder revision is invalid.", 500);
  }
  if (expectedRevision !== null && expectedRevision !== revision) {
    throw new EncryptedFolderError("Encrypted folder changed on another device.", 409);
  }
  return revision;
}

async function updateEncryptedFolder(db, id, input, expectedRevision = null) {
  const folder = normalizeEncryptedFolderEnvelope(input, id);
  const currentRevision = requireCurrentRevision(
    await readEncryptedFolderState(db, id),
    expectedRevision,
  );
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_note_folders
       SET version = ?, ciphertext = ?, nonce = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND keyring_id = ? AND revision = ?`,
    )
    .bind(
      folder.version,
      folder.ciphertext,
      folder.nonce,
      now,
      folder.id,
      KEYRING_ID,
      currentRevision,
    )
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedFolderError("Encrypted folder changed on another device.", 409);
  }
  return { ...folder, revision: currentRevision + 1, updatedAt: now };
}

async function deleteEncryptedFolder(db, id, expectedRevision = null) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedFolderError("Encrypted folder ID is invalid.", 400);
  }
  const currentRevision = requireCurrentRevision(
    await readEncryptedFolderState(db, id),
    expectedRevision,
  );
  const result = await db
    .prepare(
      `DELETE FROM encrypted_note_folders
       WHERE id = ? AND keyring_id = ? AND revision = ?`,
    )
    .bind(id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedFolderError("Encrypted folder changed on another device.", 409);
  }
}

export {
  EncryptedFolderError,
  createEncryptedFolder,
  deleteEncryptedFolder,
  listEncryptedFolders,
  normalizeEncryptedFolderEnvelope,
  updateEncryptedFolder,
};
