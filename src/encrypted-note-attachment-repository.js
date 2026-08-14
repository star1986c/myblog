const KEYRING_ID = "notes";
const ENVELOPE_VERSION = 1;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_METADATA_CIPHERTEXT_BYTES = 8_192;
const MAX_PLAINTEXT_BYTES = 10 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16;
const MAX_ATTACHMENTS_PER_NOTE = 20;
const MAX_ATTACHMENTS_TOTAL = 25_000;
const MAX_TOTAL_CIPHERTEXT_BYTES = 8 * 1024 * 1024 * 1024;

const ATTACHMENT_COLUMNS = [
  "id",
  "note_id AS noteId",
  "version",
  "revision",
  "ciphertext",
  "nonce",
  "is_locked AS isLocked",
  "ciphertext_bytes AS ciphertextBytes",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

class EncryptedNoteAttachmentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "EncryptedNoteAttachmentError";
    this.status = status;
  }
}

function requireEntryId(value, label) {
  if (typeof value !== "string" || !ENTRY_ID_PATTERN.test(value)) {
    throw new EncryptedNoteAttachmentError(`${label} is invalid.`, 400);
  }
  return value;
}

function validateBase64Url(value, label, { minBytes, maxBytes }) {
  if (typeof value !== "string" || !BASE64URL_PATTERN.test(value)) {
    throw new EncryptedNoteAttachmentError(`${label} is invalid.`, 400);
  }
  const padding = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const byteLength = Math.floor(((value.length + padding) * 3) / 4) - padding;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new EncryptedNoteAttachmentError(`${label} is invalid.`, 400);
  }
  return value;
}

function normalizeEnvelope(input, expectedId = "", expectedNoteId = "") {
  const id = requireEntryId(expectedId || input?.id, "Attachment ID");
  const noteId = requireEntryId(expectedNoteId || input?.noteId, "Note ID");
  if (input?.id && input.id !== id) {
    throw new EncryptedNoteAttachmentError("Attachment ID does not match the request path.", 400);
  }
  if (input?.noteId && input.noteId !== noteId) {
    throw new EncryptedNoteAttachmentError("Note ID does not match the request path.", 400);
  }
  const version = Number(input?.version);
  if (version !== ENVELOPE_VERSION || typeof input?.isLocked !== "boolean") {
    throw new EncryptedNoteAttachmentError("Encrypted attachment metadata is invalid.", 400);
  }
  return {
    id,
    noteId,
    version,
    ciphertext: validateBase64Url(input?.ciphertext, "Encrypted attachment metadata", {
      minBytes: 17,
      maxBytes: MAX_METADATA_CIPHERTEXT_BYTES,
    }),
    nonce: validateBase64Url(input?.nonce, "Encrypted attachment metadata nonce", {
      minBytes: 12,
      maxBytes: 12,
    }),
    isLocked: input.isLocked,
  };
}

function envelopeFromUploadHeaders(request, noteId, id) {
  return normalizeEnvelope({
    id,
    noteId,
    version: request.headers.get("X-Attachment-Version"),
    ciphertext: request.headers.get("X-Attachment-Ciphertext"),
    nonce: request.headers.get("X-Attachment-Nonce"),
    isLocked: request.headers.get("X-Attachment-Locked") === "true"
      ? true
      : request.headers.get("X-Attachment-Locked") === "false"
        ? false
        : null,
  }, id, noteId);
}

function readCiphertextLength(request) {
  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim();
  if (contentType !== "application/octet-stream") {
    throw new EncryptedNoteAttachmentError("Attachment body must be encrypted binary data.", 415);
  }
  const rawLength = request.headers.get("Content-Length") || "";
  if (!/^[1-9][0-9]*$/.test(rawLength)) {
    throw new EncryptedNoteAttachmentError("Attachment length is required.", 411);
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 17 || length > MAX_CIPHERTEXT_BYTES) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment exceeds the 10 MiB limit.", 413);
  }
  if (!request.body) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment body is required.", 400);
  }
  return length;
}

function publicEnvelope(record) {
  return {
    ...record,
    isLocked: Number(record.isLocked) === 1 || record.isLocked === true,
    ciphertextBytes: Number(record.ciphertextBytes),
  };
}

async function requireNote(db, noteId, { includeDeleted = true } = {}) {
  requireEntryId(noteId, "Note ID");
  const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
  const note = await db
    .prepare(
      `SELECT id, revision, is_locked AS isLocked, deleted_at AS deletedAt
       FROM encrypted_notes
       WHERE id = ? AND keyring_id = ? ${deletedClause}
       LIMIT 1`,
    )
    .bind(noteId, KEYRING_ID)
    .first();
  if (!note) throw new EncryptedNoteAttachmentError("Encrypted note not found.", 404);
  return note;
}

async function attachmentUsage(db, noteId = null) {
  const noteCount = noteId
    ? await db
      .prepare(
        `SELECT COUNT(*) AS attachmentCount
         FROM encrypted_note_attachments
         WHERE keyring_id = ? AND note_id = ?`,
      )
      .bind(KEYRING_ID, noteId)
      .first()
    : null;
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS attachmentCount,
              COALESCE(SUM(ciphertext_bytes), 0) AS ciphertextBytes
       FROM encrypted_note_attachments
       WHERE keyring_id = ?`,
    )
    .bind(KEYRING_ID)
    .first();
  return {
    noteAttachmentCount: Number(noteCount?.attachmentCount || 0),
    attachmentCount: Number(total?.attachmentCount || 0),
    ciphertextBytes: Number(total?.ciphertextBytes || 0),
  };
}

async function listEncryptedNoteAttachments(db, noteId) {
  await requireNote(db, noteId);
  const result = await db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
       FROM encrypted_note_attachments
       WHERE keyring_id = ? AND note_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .bind(KEYRING_ID, noteId)
    .all();
  return (result.results || []).map(publicEnvelope);
}

async function uploadEncryptedNoteAttachment(db, bucket, request, noteId, id) {
  if (!bucket || typeof bucket.put !== "function") {
    throw new EncryptedNoteAttachmentError("Encrypted attachment storage is unavailable.", 503);
  }
  const note = await requireNote(db, noteId, { includeDeleted: false });
  const envelope = envelopeFromUploadHeaders(request, noteId, id);
  if (envelope.isLocked !== (Number(note.isLocked) === 1 || note.isLocked === true)) {
    throw new EncryptedNoteAttachmentError("Note lock state changed. Refresh and try again.", 409);
  }
  const ciphertextBytes = readCiphertextLength(request);
  const usage = await attachmentUsage(db, noteId);
  if (usage.noteAttachmentCount >= MAX_ATTACHMENTS_PER_NOTE) {
    throw new EncryptedNoteAttachmentError("A note can contain at most 20 images.", 409);
  }
  if (usage.attachmentCount >= MAX_ATTACHMENTS_TOTAL) {
    throw new EncryptedNoteAttachmentError("Attachment count safety limit reached.", 507);
  }
  if (usage.ciphertextBytes + ciphertextBytes > MAX_TOTAL_CIPHERTEXT_BYTES) {
    throw new EncryptedNoteAttachmentError("Attachment storage safety limit reached.", 507);
  }

  const objectKey = `attachments/${noteId}/${id}.bin`;
  const stored = await bucket.put(objectKey, request.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/octet-stream",
      cacheControl: "no-store",
    },
    customMetadata: { noteId, attachmentId: id, version: String(ENVELOPE_VERSION) },
    storageClass: "Standard",
  });
  if (!stored) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment already exists.", 409);
  }
  if (Number(stored.size) !== ciphertextBytes) {
    await bucket.delete(objectKey);
    throw new EncryptedNoteAttachmentError("Encrypted attachment length is invalid.", 400);
  }

  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO encrypted_note_attachments (
          id, note_id, keyring_id, version, ciphertext, nonce, is_locked,
          ciphertext_bytes, object_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        envelope.id,
        envelope.noteId,
        KEYRING_ID,
        envelope.version,
        envelope.ciphertext,
        envelope.nonce,
        envelope.isLocked ? 1 : 0,
        ciphertextBytes,
        objectKey,
        now,
        now,
      )
      .run();
  } catch (error) {
    await bucket.delete(objectKey);
    if (String(error?.message || error).includes("UNIQUE")) {
      throw new EncryptedNoteAttachmentError("Encrypted attachment already exists.", 409);
    }
    throw error;
  }
  return publicEnvelope({
    ...envelope,
    revision: 1,
    ciphertextBytes,
    createdAt: now,
    updatedAt: now,
  });
}

async function readAttachmentState(db, noteId, id) {
  return await db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS}, object_key AS objectKey
       FROM encrypted_note_attachments
       WHERE id = ? AND note_id = ? AND keyring_id = ?
       LIMIT 1`,
    )
    .bind(id, noteId, KEYRING_ID)
    .first();
}

function requireAttachmentState(state, expectedRevision = null) {
  if (!state) throw new EncryptedNoteAttachmentError("Encrypted attachment not found.", 404);
  const revision = Number(state.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment revision is invalid.", 500);
  }
  if (expectedRevision !== null && expectedRevision !== revision) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment changed on another device.", 409);
  }
  return revision;
}

async function updateEncryptedNoteAttachment(db, noteId, id, input, expectedRevision = null) {
  const note = await requireNote(db, noteId);
  const envelope = normalizeEnvelope(input, id, noteId);
  if (envelope.isLocked !== (Number(note.isLocked) === 1 || note.isLocked === true)) {
    throw new EncryptedNoteAttachmentError("Note lock state changed. Refresh and try again.", 409);
  }
  const state = await readAttachmentState(db, noteId, id);
  const revision = requireAttachmentState(state, expectedRevision);
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE encrypted_note_attachments
       SET version = ?, ciphertext = ?, nonce = ?, is_locked = ?,
           revision = revision + 1, updated_at = ?
       WHERE id = ? AND note_id = ? AND keyring_id = ? AND revision = ?`,
    )
    .bind(
      envelope.version,
      envelope.ciphertext,
      envelope.nonce,
      envelope.isLocked ? 1 : 0,
      now,
      id,
      noteId,
      KEYRING_ID,
      revision,
    )
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment changed on another device.", 409);
  }
  return publicEnvelope({
    ...envelope,
    revision: revision + 1,
    ciphertextBytes: Number(state.ciphertextBytes),
    createdAt: state.createdAt,
    updatedAt: now,
  });
}

async function downloadEncryptedNoteAttachment(db, bucket, noteId, id) {
  if (!bucket || typeof bucket.get !== "function") {
    throw new EncryptedNoteAttachmentError("Encrypted attachment storage is unavailable.", 503);
  }
  await requireNote(db, noteId);
  const state = await readAttachmentState(db, noteId, id);
  requireAttachmentState(state);
  const object = await bucket.get(state.objectKey);
  if (!object?.body || Number(object.size) !== Number(state.ciphertextBytes)) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment is unavailable.", 503);
  }
  return { object, envelope: publicEnvelope(state) };
}

async function deleteEncryptedNoteAttachment(
  db,
  bucket,
  noteId,
  id,
  expectedRevision = null,
) {
  if (!bucket || typeof bucket.delete !== "function") {
    throw new EncryptedNoteAttachmentError("Encrypted attachment storage is unavailable.", 503);
  }
  await requireNote(db, noteId);
  const state = await readAttachmentState(db, noteId, id);
  const revision = requireAttachmentState(state, expectedRevision);
  await bucket.delete(state.objectKey);
  const result = await db
    .prepare(
      `DELETE FROM encrypted_note_attachments
       WHERE id = ? AND note_id = ? AND keyring_id = ? AND revision = ?`,
    )
    .bind(id, noteId, KEYRING_ID, revision)
    .run();
  if (!result.meta?.changes) {
    throw new EncryptedNoteAttachmentError("Encrypted attachment changed on another device.", 409);
  }
}

async function purgeEncryptedNoteAttachments(db, bucket, noteId, expectedNoteRevision) {
  if (!bucket || typeof bucket.delete !== "function") {
    throw new EncryptedNoteAttachmentError("Encrypted attachment storage is unavailable.", 503);
  }
  const note = await requireNote(db, noteId);
  if (!note.deletedAt) {
    throw new EncryptedNoteAttachmentError("Deleted encrypted note not found.", 404);
  }
  if (expectedNoteRevision !== null && Number(note.revision) !== expectedNoteRevision) {
    throw new EncryptedNoteAttachmentError("Encrypted note changed on another device.", 409);
  }
  const result = await db
    .prepare(
      `SELECT object_key AS objectKey
       FROM encrypted_note_attachments
       WHERE note_id = ? AND keyring_id = ?
       ORDER BY id ASC`,
    )
    .bind(noteId, KEYRING_ID)
    .all();
  const keys = (result.results || []).map((item) => item.objectKey).filter(Boolean);
  if (keys.length) await bucket.delete(keys);
}

async function encryptedAttachmentUsage(db) {
  const usage = await attachmentUsage(db);
  return {
    attachmentCount: usage.attachmentCount,
    ciphertextBytes: usage.ciphertextBytes,
    maxCiphertextBytes: MAX_TOTAL_CIPHERTEXT_BYTES,
    maxAttachmentBytes: MAX_CIPHERTEXT_BYTES,
    maxAttachmentsPerNote: MAX_ATTACHMENTS_PER_NOTE,
  };
}

async function requireAttachmentCapableClient(db, noteId, request) {
  if (request.headers.get("X-Attachment-Support") === "1") return;
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS attachmentCount
       FROM encrypted_note_attachments
       WHERE keyring_id = ? AND note_id = ?`,
    )
    .bind(KEYRING_ID, noteId)
    .first();
  if (Number(count?.attachmentCount || 0) > 0) {
    throw new EncryptedNoteAttachmentError(
      "This note contains encrypted images. Update My Notes before saving.",
      409,
    );
  }
}

export {
  EncryptedNoteAttachmentError,
  deleteEncryptedNoteAttachment,
  downloadEncryptedNoteAttachment,
  encryptedAttachmentUsage,
  listEncryptedNoteAttachments,
  normalizeEnvelope,
  purgeEncryptedNoteAttachments,
  requireAttachmentCapableClient,
  updateEncryptedNoteAttachment,
  uploadEncryptedNoteAttachment,
};
