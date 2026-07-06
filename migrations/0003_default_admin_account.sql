CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO admin_accounts (id, username, password_hash, must_change_password)
SELECT
  'default',
  'admin',
  'pbkdf2_sha256$100000$pfV0ZXPLdZWc48ZOUPTN3w$PEzJoCctnr5HQ-vY-Z7ngIzU5Ac7fsFZTMrllw2CLX4',
  1
WHERE NOT EXISTS (
  SELECT 1 FROM admin_accounts WHERE id = 'default'
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO admin_settings (key, value)
SELECT
  'session_secret',
  'OFYMpfHr4H8t9XEAsLcSCSHgdyH8PPKmRPPt-CTCqCA'
WHERE NOT EXISTS (
  SELECT 1 FROM admin_settings WHERE key = 'session_secret'
);
