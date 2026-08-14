-- Persist a deterministic manual folder order shared by native clients.
ALTER TABLE encrypted_note_folders
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Preserve the previous created_at ordering for existing folders, including timestamp ties.
UPDATE encrypted_note_folders AS target
SET sort_order = (
  SELECT COUNT(*)
  FROM encrypted_note_folders AS preceding
  WHERE preceding.keyring_id = target.keyring_id
    AND (
      preceding.created_at < target.created_at
      OR (preceding.created_at = target.created_at AND preceding.id < target.id)
    )
);

CREATE INDEX idx_encrypted_note_folders_keyring_order
  ON encrypted_note_folders (keyring_id, sort_order ASC, created_at ASC);
