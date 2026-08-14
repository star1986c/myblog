-- Store only encrypted attachment envelopes and opaque R2 object references.
CREATE TABLE encrypted_note_attachments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  keyring_id TEXT NOT NULL CHECK (keyring_id = 'notes'),
  version INTEGER NOT NULL CHECK (version = 1),
  revision INTEGER NOT NULL DEFAULT 1,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1)),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes BETWEEN 17 AND 10485776),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (note_id) REFERENCES encrypted_notes(id) ON DELETE CASCADE,
  FOREIGN KEY (keyring_id) REFERENCES workspace_keyrings(id) ON DELETE CASCADE
);

CREATE INDEX idx_encrypted_note_attachments_note
  ON encrypted_note_attachments (note_id, created_at ASC, id ASC);

CREATE INDEX idx_encrypted_note_attachments_usage
  ON encrypted_note_attachments (keyring_id, ciphertext_bytes);

-- Keep the server-visible lock marker aligned without exposing attachment metadata.
CREATE TRIGGER sync_attachment_lock_state
AFTER UPDATE OF is_locked ON encrypted_notes
FOR EACH ROW
WHEN OLD.is_locked <> NEW.is_locked
BEGIN
  UPDATE encrypted_note_attachments
  SET is_locked = NEW.is_locked,
      updated_at = NEW.updated_at,
      revision = revision + 1
  WHERE note_id = NEW.id AND keyring_id = NEW.keyring_id;
END;
