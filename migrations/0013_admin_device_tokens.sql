CREATE TABLE IF NOT EXISTS admin_device_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_device_tokens_account
  ON admin_device_tokens(account_id, last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_device_tokens_expiry
  ON admin_device_tokens(expires_at);
