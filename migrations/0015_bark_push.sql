-- Additive only: independent from encrypted notes and Hermes history.
CREATE TABLE IF NOT EXISTS bark_devices (
  device_key TEXT PRIMARY KEY,
  device_token TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'iPhone',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  profile_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS bark_deliveries (
  device_key TEXT NOT NULL REFERENCES bark_devices(device_key) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (device_key, event_id)
);
CREATE INDEX IF NOT EXISTS bark_deliveries_sent_at ON bark_deliveries(sent_at);
