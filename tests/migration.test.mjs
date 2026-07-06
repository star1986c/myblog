import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_blog.sql", import.meta.url), "utf8");

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
