const KEYRING_ID = "notes";
const KEYRING_VERSION = 1;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CIPHERTEXT_BYTES = 2_100_000;
const PLAINTEXT_FIELDS = [
  "title",
  "content",
  "excerpt",
  "password",
  "username",
  "notes",
  "masterPassword",
];

const NOTE_COLUMNS = [
  "id",
  "folder_id AS folderId",
  "version",
  "revision",
  "ciphertext",
  "nonce",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
  "deleted_at AS deletedAt",
].join(", ");

class EncryptedNoteError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "EncryptedNoteError";
    this.status = status;
  }
}

function rejectPlaintextFields(input) {
  const field = PLAINTEXT_FIELDS.find((name) => Object.hasOwn(input || {}, name));
  if (field) {
    throw new EncryptedNoteError("Private notes API accepts encrypted data only.", 400);
  }
}

function validateBase64Url(value, label, { minBytes, maxBytes }) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new EncryptedNoteError(`${label} is invalid.`, 400);
  }
  const padding = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const byteLength = Math.floor(((value.length + padding) * 3) / 4) - padding;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new EncryptedNoteError(`${label} is invalid.`, 400);
  }
  return value;
}

function normalizeEncryptedNoteEnvelope(input, expectedId = "") {
  rejectPlaintextFields(input);
  const id = expectedId || (typeof input?.id === "string" ? input.id : "");
  const note = {
    id,
    version: Number(input?.version),
    ciphertext: validateBase64Url(input?.ciphertext, "Encrypted note", {
      minBytes: 17,
      maxBytes: MAX_CIPHERTEXT_BYTES,
    }),
    nonce: validateBase64Url(input?.nonce, "Encrypted note nonce", {
      minBytes: 12,
      maxBytes: 12,
    }),
  };
  if (!ENTRY_ID_PATTERN.test(note.id) || note.version !== KEYRING_VERSION) {
    throw new EncryptedNoteError("Encrypted note metadata is invalid.", 400);
  }
  if (input?.id && input.id !== note.id) {
    throw new EncryptedNoteError("Encrypted note ID does not match the request path.", 400);
  }
  return note;
}

async function requireWorkspaceKey(db) {
  const keyring = await db
    .prepare("SELECT id FROM workspace_keyrings WHERE id = ? LIMIT 1")
    .bind(KEYRING_ID)
    .first();
  if (!keyring) {
    throw new EncryptedNoteError("Encrypted workspace key is not configured.", 409);
  }
}

async function listEncryptedNotes(db) {
  const result = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}
       FROM encrypted_notes
       WHERE keyring_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .bind(KEYRING_ID)
    .all();
  return result.results || [];
}

async function listDeletedEncryptedNotes(db) {
  const result = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}
       FROM encrypted_notes
       WHERE keyring_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC, updated_at DESC`,
    )
    .bind(KEYRING_ID)
    .all();
  return result.results || [];
}

async function createEncryptedNote(db, input) {
  await requireWorkspaceKey(db);
  const note = normalizeEncryptedNoteEnvelope(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO encrypted_notes (
          id, keyring_id, version, ciphertext, nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(note.id, KEYRING_ID, note.version, note.ciphertext, note.nonce, now, now)
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new EncryptedNoteError("Encrypted note already exists.", 409);
    }
    throw error;
  }
  return {
    ...note,
    folderId: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

async function readEncryptedNoteState(db, id) {
  return await db
    .prepare(
      `SELECT revision, folder_id AS folderId, deleted_at AS deletedAt
       FROM encrypted_notes
       WHERE id = ? AND keyring_id = ?
       LIMIT 1`,
    )
    .bind(id, KEYRING_ID)
    .first();
}

function requireCurrentRevision(state, expectedRevision) {
  if (!state || state.deletedAt) {
    throw new EncryptedNoteError("Encrypted note not found.", 404);
  }
  const revision = Number(state.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new EncryptedNoteError("Encrypted note revision is invalid.", 500);
  }
  if (expectedRevision !== null && expectedRevision !== revision) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  return revision;
}

async function updateEncryptedNote(db, id, input, expectedRevision = null) {
  const note = normalizeEncryptedNoteEnvelope(input, id);
  const state = await readEncryptedNoteState(db, note.id);
  const currentRevision = requireCurrentRevision(state, expectedRevision);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_notes
       SET version = ?, ciphertext = ?, nonce = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND keyring_id = ? AND deleted_at IS NULL AND revision = ?`,
    )
    .bind(note.version, note.ciphertext, note.nonce, now, note.id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  return {
    ...note,
    folderId: state.folderId || null,
    revision: currentRevision + 1,
    updatedAt: now,
    deletedAt: null,
  };
}

async function deleteEncryptedNote(db, id, expectedRevision = null) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedNoteError("Encrypted note ID is invalid.", 400);
  }
  const state = await readEncryptedNoteState(db, id);
  const currentRevision = requireCurrentRevision(state, expectedRevision);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_notes
       SET deleted_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND keyring_id = ? AND deleted_at IS NULL AND revision = ?`,
    )
    .bind(now, now, id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  return {
    id,
    folderId: state.folderId || null,
    revision: currentRevision + 1,
    updatedAt: now,
    deletedAt: now,
  };
}

async function restoreEncryptedNote(db, id, expectedRevision = null) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedNoteError("Encrypted note ID is invalid.", 400);
  }
  const state = await readEncryptedNoteState(db, id);
  if (!state || !state.deletedAt) {
    throw new EncryptedNoteError("Deleted encrypted note not found.", 404);
  }
  const currentRevision = Number(state.revision);
  if (!Number.isInteger(currentRevision) || currentRevision < 1) {
    throw new EncryptedNoteError("Encrypted note revision is invalid.", 500);
  }
  if (expectedRevision !== null && expectedRevision !== currentRevision) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_notes
       SET deleted_at = NULL, updated_at = ?, revision = revision + 1
       WHERE id = ? AND keyring_id = ? AND deleted_at IS NOT NULL AND revision = ?`,
    )
    .bind(now, id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  return {
    id,
    folderId: state.folderId || null,
    revision: currentRevision + 1,
    updatedAt: now,
    deletedAt: null,
  };
}

async function moveEncryptedNote(db, id, input, expectedRevision = null) {
  rejectPlaintextFields(input);
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedNoteError("Encrypted note ID is invalid.", 400);
  }
  const folderId = input?.folderId === null ? null : input?.folderId;
  if (folderId !== null && !ENTRY_ID_PATTERN.test(folderId || "")) {
    throw new EncryptedNoteError("Encrypted folder ID is invalid.", 400);
  }
  if (folderId) {
    const folder = await db
      .prepare(
        `SELECT id FROM encrypted_note_folders
         WHERE id = ? AND keyring_id = ?
         LIMIT 1`,
      )
      .bind(folderId, KEYRING_ID)
      .first();
    if (!folder) {
      throw new EncryptedNoteError("Encrypted folder not found.", 404);
    }
  }
  const state = await readEncryptedNoteState(db, id);
  const currentRevision = requireCurrentRevision(state, expectedRevision);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_notes
       SET folder_id = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND keyring_id = ? AND deleted_at IS NULL AND revision = ?`,
    )
    .bind(folderId, now, id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  return {
    id,
    folderId,
    revision: currentRevision + 1,
    updatedAt: now,
    deletedAt: null,
  };
}

async function purgeEncryptedNote(db, id, expectedRevision = null) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedNoteError("Encrypted note ID is invalid.", 400);
  }
  const state = await readEncryptedNoteState(db, id);
  if (!state || !state.deletedAt) {
    throw new EncryptedNoteError("Deleted encrypted note not found.", 404);
  }
  const currentRevision = Number(state.revision);
  if (!Number.isInteger(currentRevision) || currentRevision < 1) {
    throw new EncryptedNoteError("Encrypted note revision is invalid.", 500);
  }
  if (expectedRevision !== null && expectedRevision !== currentRevision) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
  const result = await db
    .prepare(
      `DELETE FROM encrypted_notes
       WHERE id = ? AND keyring_id = ? AND deleted_at IS NOT NULL AND revision = ?`,
    )
    .bind(id, KEYRING_ID, currentRevision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note changed on another device.", 409);
  }
}

export {
  EncryptedNoteError,
  createEncryptedNote,
  deleteEncryptedNote,
  listDeletedEncryptedNotes,
  listEncryptedNotes,
  moveEncryptedNote,
  normalizeEncryptedNoteEnvelope,
  purgeEncryptedNote,
  restoreEncryptedNote,
  updateEncryptedNote,
};
