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
const privateNotesMigration = await readFile(
  new URL("../migrations/0005_make_blog_private.sql", import.meta.url),
  "utf8",
);
const legacyBlogDeletionMigration = await readFile(
  new URL("../migrations/0006_delete_legacy_blog_content.sql", import.meta.url),
  "utf8",
);
const recoverableNotesKeyMigration = await readFile(
  new URL("../migrations/0007_recoverable_notes_key.sql", import.meta.url),
  "utf8",
);
const noteTrashMigration = await readFile(
  new URL("../migrations/0008_note_trash_and_revisions.sql", import.meta.url),
  "utf8",
);
const encryptedNoteFoldersMigration = await readFile(
  new URL("../migrations/0009_encrypted_note_folders.sql", import.meta.url),
  "utf8",
);
const noteProtectionMigration = await readFile(
  new URL("../migrations/0010_note_protection.sql", import.meta.url),
  "utf8",
);
const encryptedFolderOrderMigration = await readFile(
  new URL("../migrations/0011_encrypted_folder_order.sql", import.meta.url),
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

test("private notes migration revokes publication and stores encrypted envelopes only", () => {
  assert.match(privateNotesMigration, /UPDATE posts/);
  assert.match(privateNotesMigration, /UPDATE pages/);
  assert.match(privateNotesMigration, /visibility = 'private'/);
  assert.match(privateNotesMigration, /CREATE TABLE IF NOT EXISTS encrypted_notes/);
  assert.match(privateNotesMigration, /ciphertext TEXT NOT NULL/);
  assert.match(privateNotesMigration, /nonce TEXT NOT NULL/);
  assert.doesNotMatch(privateNotesMigration, /(?:^|\s)(?:title|content|password|username)\s+TEXT/im);
  assert.doesNotMatch(privateNotesMigration, /published_at\s*=|updated_at\s*=/);
});

test("legacy blog deletion removes plaintext content without touching private data", () => {
  assert.match(legacyBlogDeletionMigration, /DELETE FROM post_categories/);
  assert.match(legacyBlogDeletionMigration, /DELETE FROM posts/);
  assert.match(legacyBlogDeletionMigration, /DELETE FROM pages/);
  assert.match(legacyBlogDeletionMigration, /DELETE FROM categories/);
  assert.match(legacyBlogDeletionMigration, /DELETE FROM media_assets/);
  assert.doesNotMatch(
    legacyBlogDeletionMigration,
    /DELETE FROM (?:admin_accounts|password_vaults|password_vault_entries|encrypted_notes)/,
  );
});

test("recoverable notes key migration retires the forgotten master-password vault", () => {
  assert.match(recoverableNotesKeyMigration, /CREATE TABLE IF NOT EXISTS workspace_keyrings/);
  assert.match(recoverableNotesKeyMigration, /wrapped_key TEXT NOT NULL/);
  assert.match(recoverableNotesKeyMigration, /nonce TEXT NOT NULL/);
  assert.match(recoverableNotesKeyMigration, /keyring_id TEXT NOT NULL/);
  assert.match(recoverableNotesKeyMigration, /REFERENCES workspace_keyrings\(id\)/);
  assert.match(recoverableNotesKeyMigration, /DROP TABLE password_vault_entries/);
  assert.match(recoverableNotesKeyMigration, /DROP TABLE password_vaults/);
  assert.doesNotMatch(
    recoverableNotesKeyMigration,
    /(?:^|\s)(?:title|content|password|username|master_password)\s+TEXT/im,
  );
  assert.doesNotMatch(recoverableNotesKeyMigration, /NOTES_KEY_ENCRYPTION_SECRET\s*=/);
});

test("note trash migration adds revisions and recoverable soft deletion without plaintext", () => {
  assert.match(noteTrashMigration, /ADD COLUMN revision INTEGER NOT NULL DEFAULT 1/);
  assert.match(noteTrashMigration, /ADD COLUMN deleted_at TEXT/);
  assert.match(noteTrashMigration, /WHERE deleted_at IS NULL/);
  assert.match(noteTrashMigration, /WHERE deleted_at IS NOT NULL/);
  assert.doesNotMatch(noteTrashMigration, /(?:^|\s)(?:title|content|password|username)\s+TEXT/im);
});

test("encrypted note folders migration stores encrypted names and opaque note membership", () => {
  assert.match(encryptedNoteFoldersMigration, /CREATE TABLE encrypted_note_folders/);
  assert.match(encryptedNoteFoldersMigration, /ciphertext TEXT NOT NULL/);
  assert.match(encryptedNoteFoldersMigration, /nonce TEXT NOT NULL/);
  assert.match(encryptedNoteFoldersMigration, /ADD COLUMN folder_id TEXT/);
  assert.match(encryptedNoteFoldersMigration, /AFTER DELETE ON encrypted_note_folders/);
  assert.match(encryptedNoteFoldersMigration, /SET folder_id = NULL/);
  assert.match(encryptedNoteFoldersMigration, /revision = revision \+ 1/);
  assert.doesNotMatch(
    encryptedNoteFoldersMigration,
    /(?:^|\s)(?:name|title|content|password|username)\s+TEXT/im,
  );
});

test("note protection migration stores lock metadata and wrapped keys without plaintext", () => {
  assert.match(noteProtectionMigration, /ADD COLUMN is_locked INTEGER NOT NULL DEFAULT 0/);
  assert.match(noteProtectionMigration, /CREATE TABLE note_protection_keyrings/);
  assert.match(noteProtectionMigration, /kdf TEXT NOT NULL/);
  assert.match(noteProtectionMigration, /wrapped_key TEXT NOT NULL/);
  assert.match(noteProtectionMigration, /nonce TEXT NOT NULL/);
  assert.doesNotMatch(
    noteProtectionMigration,
    /(?:^|\s)(?:password|title|content|plaintext|data_key)\s+TEXT/im,
  );
});

test("encrypted folder order migration preserves the previous deterministic order", () => {
  assert.match(encryptedFolderOrderMigration, /ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0/);
  assert.match(encryptedFolderOrderMigration, /preceding\.created_at < target\.created_at/);
  assert.match(encryptedFolderOrderMigration, /preceding\.id < target\.id/);
  assert.match(encryptedFolderOrderMigration, /keyring_id, sort_order ASC/);
  assert.doesNotMatch(
    encryptedFolderOrderMigration,
    /(?:^|\s)(?:name|title|content|password|username)\s+TEXT/im,
  );
});
