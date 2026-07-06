ALTER TABLE media_assets ADD COLUMN url TEXT NOT NULL DEFAULT '';

UPDATE media_assets SET url = object_key
WHERE url = '' AND object_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_url
  ON media_assets (url);
