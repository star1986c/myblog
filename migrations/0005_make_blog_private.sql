-- The public blog is now a private notes workspace. Keep existing data while
-- removing every publication flag before the new Worker is deployed.
UPDATE posts
SET status = 'draft',
    visibility = 'private';

UPDATE pages
SET status = 'draft',
    visibility = 'private';

CREATE TABLE IF NOT EXISTS encrypted_notes (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vault_id) REFERENCES password_vaults(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_encrypted_notes_vault_updated
  ON encrypted_notes (vault_id, updated_at DESC, created_at DESC);
