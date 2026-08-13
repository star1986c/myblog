-- Replace the forgotten master-password vault with a recoverable workspace key.
-- The wrapping secret lives in the Worker environment and is never stored in D1.
CREATE TABLE IF NOT EXISTS workspace_keyrings (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version = 1),
  wrapped_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP INDEX IF EXISTS idx_encrypted_notes_vault_updated;
ALTER TABLE encrypted_notes RENAME TO encrypted_notes_master_password_legacy;

CREATE TABLE encrypted_notes (
  id TEXT PRIMARY KEY,
  keyring_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (keyring_id) REFERENCES workspace_keyrings(id) ON DELETE CASCADE
);

CREATE INDEX idx_encrypted_notes_keyring_updated
  ON encrypted_notes (keyring_id, updated_at DESC, created_at DESC);

DROP TABLE encrypted_notes_master_password_legacy;
DROP TABLE password_vault_entries;
DROP TABLE password_vaults;
