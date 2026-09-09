// One statement reads the cursor, change index and current envelopes from the
// same database snapshot. A concurrent update moves the entity to a newer
// sequence, so it will be delivered on a later page or the next sync.
export const NOTES_SYNC_SQL = `
WITH state AS (
  SELECT epoch, COALESCE((SELECT MAX(sequence) FROM notes_sync_changes
    WHERE keyring_id = 'notes'), 0) AS head FROM notes_sync_epoch WHERE id = 1
), baseline AS (
  SELECT *, CASE WHEN epoch = ? AND ? BETWEEN 0 AND head THEN 0 ELSE 1 END AS reset,
    CASE WHEN epoch = ? AND ? BETWEEN 0 AND head THEN ? ELSE 0 END AS after_sequence
  FROM state
), candidates AS (
  SELECT c.sequence, c.kind, c.entity_id,
    COALESCE(length(n.ciphertext), length(f.ciphertext), 0) + 1024 AS bytes
  FROM notes_sync_changes c
  LEFT JOIN encrypted_notes n ON c.kind = 'note' AND n.id = c.entity_id AND n.keyring_id = c.keyring_id
  LEFT JOIN encrypted_note_folders f ON c.kind = 'folder' AND f.id = c.entity_id AND f.keyring_id = c.keyring_id
  WHERE c.keyring_id = 'notes' AND c.sequence > (SELECT after_sequence FROM baseline)
  ORDER BY c.sequence LIMIT 101
), budgeted AS (
  SELECT *, SUM(bytes) OVER (ORDER BY sequence) AS running_bytes,
    ROW_NUMBER() OVER (ORDER BY sequence) AS row_number FROM candidates
), page AS (
  SELECT * FROM budgeted WHERE row_number <= 100
    AND (running_bytes <= 4194304 OR row_number = 1)
), result_state AS (
  SELECT *, EXISTS(SELECT 1 FROM notes_sync_changes
    WHERE keyring_id = 'notes' AND sequence > COALESCE((SELECT MAX(sequence) FROM page), head)) AS has_more
  FROM baseline
)
SELECT s.epoch, s.head, s.reset, s.has_more AS hasMore,
  p.sequence, p.kind, p.entity_id AS id,
  CASE WHEN p.kind = 'note' AND n.id IS NOT NULL THEN json_object(
    'id', n.id, 'folderId', n.folder_id, 'version', n.version, 'revision', n.revision,
    'ciphertext', n.ciphertext, 'nonce', n.nonce, 'isLocked', n.is_locked,
    'createdAt', n.created_at, 'updatedAt', n.updated_at, 'deletedAt', n.deleted_at,
    'attachmentCount', (SELECT COUNT(*) FROM encrypted_note_attachments a
      WHERE a.note_id = n.id AND a.keyring_id = n.keyring_id))
  WHEN p.kind = 'folder' AND f.id IS NOT NULL THEN json_object(
    'id', f.id, 'version', f.version, 'revision', f.revision,
    'ciphertext', f.ciphertext, 'nonce', f.nonce, 'sortOrder', f.sort_order,
    'createdAt', f.created_at, 'updatedAt', f.updated_at)
  ELSE NULL END AS envelope
FROM result_state s LEFT JOIN page p ON 1 = 1
LEFT JOIN encrypted_notes n ON p.kind = 'note' AND n.id = p.entity_id AND n.keyring_id = 'notes'
LEFT JOIN encrypted_note_folders f ON p.kind = 'folder' AND f.id = p.entity_id AND f.keyring_id = 'notes'
ORDER BY p.sequence`;

export async function syncEncryptedNotes(db, cursor = "") {
  const match = typeof cursor === "string" && cursor.match(/^([a-f0-9]{32}):([0-9]{1,16})$/);
  const sequence = match ? Number(match[2]) : -1;
  const epoch = match && Number.isSafeInteger(sequence) ? match[1] : "";
  const result = await db.prepare(NOTES_SYNC_SQL)
    .bind(epoch, sequence, epoch, sequence, sequence).all();
  const rows = result.results || [];
  if (!rows.length) throw new Error("Notes sync migration is not initialized.");
  const state = rows[0];
  const changes = rows.filter((row) => row.id != null).map((row) => {
    const envelope = row.envelope == null ? null : JSON.parse(row.envelope);
    if (row.kind === "note" && envelope) envelope.isLocked = Boolean(envelope.isLocked);
    return { kind: row.kind, id: row.id, deleted: envelope === null,
      ...(envelope ? { [row.kind]: envelope } : {}) };
  });
  const hasMore = Boolean(state.hasMore);
  return { version: 1, reset: Boolean(state.reset), hasMore,
    cursor: `${state.epoch}:${hasMore ? rows.at(-1).sequence : state.head}`, changes };
}
