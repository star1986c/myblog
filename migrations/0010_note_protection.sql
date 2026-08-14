ALTER TABLE encrypted_notes
ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0, 1));

CREATE INDEX idx_encrypted_notes_locked
ON encrypted_notes (keyring_id, is_locked, updated_at DESC);

CREATE TABLE note_protection_keyrings (
  id TEXT PRIMARY KEY CHECK (id = 'notes-protection'),
  version INTEGER NOT NULL CHECK (version = 1),
  kdf TEXT NOT NULL CHECK (kdf = 'PBKDF2-SHA256'),
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 100000 AND 2000000),
  salt TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
