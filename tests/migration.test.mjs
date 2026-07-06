import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_blog.sql", import.meta.url), "utf8");
const manualMediaMigration = await readFile(
  new URL("../migrations/0002_manual_media_urls.sql", import.meta.url),
  "utf8",
);

test("blog migration defaults posts and pages to private drafts", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS posts/);
  assert.match(migration, /status TEXT NOT NULL DEFAULT 'draft'/);
  assert.match(migration, /visibility TEXT NOT NULL DEFAULT 'private'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pages/);
});

test("blog migration indexes only public published lookup paths", () => {
  assert.match(migration, /idx_posts_public/);
  assert.match(migration, /status, visibility, published_at/);
});

test("manual media migration adds URL storage without R2 objects", () => {
  assert.match(manualMediaMigration, /ALTER TABLE media_assets ADD COLUMN url TEXT/);
  assert.match(manualMediaMigration, /UPDATE media_assets SET url = object_key/);
  assert.match(manualMediaMigration, /idx_media_assets_url/);
});
