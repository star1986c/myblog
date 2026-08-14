-- Add encrypted folder names and opaque note classification without exposing plaintext.
CREATE TABLE encrypted_note_folders (
  id TEXT PRIMARY KEY,
  keyring_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (keyring_id) REFERENCES workspace_keyrings(id) ON DELETE CASCADE
);

CREATE INDEX idx_encrypted_note_folders_keyring_created
  ON encrypted_note_folders (keyring_id, created_at ASC);

ALTER TABLE encrypted_notes ADD COLUMN folder_id TEXT;

CREATE INDEX idx_encrypted_notes_active_folder_updated
  ON encrypted_notes (keyring_id, folder_id, updated_at DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER encrypted_note_folders_unfile_notes
AFTER DELETE ON encrypted_note_folders
BEGIN
  UPDATE encrypted_notes
  SET folder_id = NULL,
      updated_at = datetime('now'),
      revision = revision + 1
  WHERE keyring_id = OLD.keyring_id AND folder_id = OLD.id;
END;
