CREATE TABLE IF NOT EXISTS password_vaults (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version = 1),
  kdf TEXT NOT NULL CHECK (kdf = 'PBKDF2-SHA-256'),
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 100000 AND 2000000),
  salt TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrap_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_vault_entries (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version = 1),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vault_id) REFERENCES password_vaults(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_vault_entries_vault_updated
  ON password_vault_entries (vault_id, updated_at DESC, created_at DESC);

DELETE FROM admin_settings WHERE key = 'session_secret';
