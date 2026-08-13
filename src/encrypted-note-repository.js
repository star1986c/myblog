const VAULT_ID = "default";
const VAULT_VERSION = 1;
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
  "version",
  "ciphertext",
  "nonce",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
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
  if (!ENTRY_ID_PATTERN.test(note.id) || note.version !== VAULT_VERSION) {
    throw new EncryptedNoteError("Encrypted note metadata is invalid.", 400);
  }
  if (input?.id && input.id !== note.id) {
    throw new EncryptedNoteError("Encrypted note ID does not match the request path.", 400);
  }
  return note;
}

async function requireVault(db) {
  const vault = await db
    .prepare("SELECT id FROM password_vaults WHERE id = ? LIMIT 1")
    .bind(VAULT_ID)
    .first();
  if (!vault) {
    throw new EncryptedNoteError("Encrypted vault is not configured.", 409);
  }
}

async function listEncryptedNotes(db) {
  const result = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS}
       FROM encrypted_notes
       WHERE vault_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .bind(VAULT_ID)
    .all();
  return result.results || [];
}

async function createEncryptedNote(db, input) {
  await requireVault(db);
  const note = normalizeEncryptedNoteEnvelope(input);
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO encrypted_notes (
          id, vault_id, version, ciphertext, nonce, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(note.id, VAULT_ID, note.version, note.ciphertext, note.nonce, now, now)
      .run();
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new EncryptedNoteError("Encrypted note already exists.", 409);
    }
    throw error;
  }
  return { ...note, createdAt: now, updatedAt: now };
}

async function updateEncryptedNote(db, id, input) {
  const note = normalizeEncryptedNoteEnvelope(input, id);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_notes
       SET version = ?, ciphertext = ?, nonce = ?, updated_at = ?
       WHERE id = ? AND vault_id = ?`,
    )
    .bind(note.version, note.ciphertext, note.nonce, now, note.id, VAULT_ID)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note not found.", 404);
  }
  return { ...note, updatedAt: now };
}

async function deleteEncryptedNote(db, id) {
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new EncryptedNoteError("Encrypted note ID is invalid.", 400);
  }
  const result = await db
    .prepare("DELETE FROM encrypted_notes WHERE id = ? AND vault_id = ?")
    .bind(id, VAULT_ID)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteError("Encrypted note not found.", 404);
  }
}

export {
  EncryptedNoteError,
  createEncryptedNote,
  deleteEncryptedNote,
  listEncryptedNotes,
  normalizeEncryptedNoteEnvelope,
  updateEncryptedNote,
};
