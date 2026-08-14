-- Add optimistic concurrency and a recoverable trash state without exposing plaintext.
ALTER TABLE encrypted_notes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE encrypted_notes ADD COLUMN deleted_at TEXT;

DROP INDEX IF EXISTS idx_encrypted_notes_keyring_updated;

CREATE INDEX idx_encrypted_notes_active_updated
  ON encrypted_notes (keyring_id, updated_at DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_encrypted_notes_trashed
  ON encrypted_notes (keyring_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
