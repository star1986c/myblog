import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_blog.sql", import.meta.url), "utf8");
const manualMediaMigration = await readFile(
  new URL("../migrations/0002_manual_media_urls.sql", import.meta.url),
  "utf8",
);
const defaultAdminMigration = await readFile(
  new URL("../migrations/0003_default_admin_account.sql", import.meta.url),
  "utf8",
);
const passwordVaultMigration = await readFile(
  new URL("../migrations/0004_password_vault.sql", import.meta.url),
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

test("default admin migration seeds a D1-backed login account", () => {
  assert.match(defaultAdminMigration, /CREATE TABLE IF NOT EXISTS admin_accounts/);
  assert.match(defaultAdminMigration, /CREATE TABLE IF NOT EXISTS admin_settings/);
  assert.match(defaultAdminMigration, /INSERT INTO admin_accounts/);
  assert.match(defaultAdminMigration, /must_change_password/);
  assert.match(defaultAdminMigration, /session_secret/);
});

test("password vault migration stores only versioned encrypted payloads", () => {
  assert.match(passwordVaultMigration, /CREATE TABLE IF NOT EXISTS password_vaults/);
  assert.match(passwordVaultMigration, /CREATE TABLE IF NOT EXISTS password_vault_entries/);
  assert.match(passwordVaultMigration, /wrapped_key TEXT NOT NULL/);
  assert.match(passwordVaultMigration, /ciphertext TEXT NOT NULL/);
  assert.match(passwordVaultMigration, /nonce TEXT NOT NULL/);
  assert.match(passwordVaultMigration, /PBKDF2-SHA-256/);
  assert.match(passwordVaultMigration, /DELETE FROM admin_settings WHERE key = 'session_secret'/);
  assert.doesNotMatch(passwordVaultMigration, /(?:^|\s)(?:username|url|notes)\s+TEXT/im);
  assert.doesNotMatch(passwordVaultMigration, /(?:^|\s)password\s+TEXT/im);
});
