import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { syncEncryptedNotes } from "../src/notes-sync-repository.js";
import worker from "../src/worker.js";

function database({ seedBeforeMigration = false } = {}) {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
  for (const file of files.filter((name) => name.endsWith(".sql") && !name.startsWith("0014"))) {
    sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  sql.exec("INSERT INTO workspace_keyrings(id, version, wrapped_key, nonce) VALUES ('notes', 1, 'wrapped', 'nonce')");
  const note = (id, text = "encrypted-body") => sql.prepare(`INSERT INTO encrypted_notes
    (id,keyring_id,version,ciphertext,nonce) VALUES (?,'notes',1,?,'nonce')`).run(id, text);
  if (seedBeforeMigration) note("existing-note");
  sql.exec(readFileSync(new URL("../migrations/0014_notes_incremental_sync.sql", import.meta.url), "utf8"));
  const db = { prepare(query) { return { bind(...args) { return {
    async all() { return { results: sql.prepare(query).all(...args) }; },
  }; } }; } };
  return { sql, db, note, sync: (cursor) => syncEncryptedNotes(db, cursor) };
}

test("bootstrap includes existing rows, idle sync excludes all ciphertext", async () => {
  const d = database({ seedBeforeMigration: true });
  try {
    const initial = await d.sync();
    assert.equal(initial.reset, true);
    assert.equal(initial.changes[0].note.id, "existing-note");
    const idle = await d.sync(initial.cursor);
    assert.equal(idle.reset, false);
    assert.deepEqual(idle.changes, []);
    assert.equal(idle.cursor, initial.cursor);
    assert.ok(JSON.stringify(idle).length < 150);
  } finally { d.sql.close(); }
});

test("updates coalesce, trash/restore and permanent deletion reach other devices", async () => {
  const d = database();
  try {
    d.note("note-a"); d.note("note-b");
    let page = await d.sync();
    d.sql.exec("UPDATE encrypted_notes SET ciphertext='second', revision=2 WHERE id='note-a'");
    d.sql.exec("UPDATE encrypted_notes SET ciphertext='third', revision=3 WHERE id='note-a'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes.length, 1);
    assert.equal(page.changes[0].note.ciphertext, "third");
    d.sql.exec("UPDATE encrypted_notes SET deleted_at='now', revision=4 WHERE id='note-a'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes[0].note.deletedAt, "now");
    d.sql.exec("UPDATE encrypted_notes SET deleted_at=NULL, revision=5 WHERE id='note-a'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes[0].note.deletedAt, null);
    d.sql.exec("DELETE FROM encrypted_notes WHERE id='note-a'");
    page = await d.sync(page.cursor);
    assert.deepEqual(page.changes, [{ kind: "note", id: "note-a", deleted: true }]);
    assert.equal(d.sql.prepare("SELECT COUNT(*) AS n FROM notes_sync_changes").get().n, 2);
  } finally { d.sql.close(); }
});

test("folder ordering, folder removal and attachment mutations invalidate the right entities", async () => {
  const d = database();
  try {
    d.note("note-a");
    d.sql.exec("INSERT INTO encrypted_note_folders(id,keyring_id,version,ciphertext,nonce) VALUES ('folder-a','notes',1,'folder','nonce')");
    d.sql.exec("UPDATE encrypted_notes SET folder_id='folder-a' WHERE id='note-a'");
    let page = await d.sync();
    d.sql.exec("UPDATE encrypted_note_folders SET sort_order=7 WHERE id='folder-a'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes[0].folder.sortOrder, 7);
    assert.equal(page.changes[0].folder.revision, 1);
    d.sql.exec("DELETE FROM encrypted_note_folders WHERE id='folder-a'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes.find((c) => c.kind === "folder").deleted, true);
    assert.equal(page.changes.find((c) => c.kind === "note").note.folderId, null);
    d.sql.exec(`INSERT INTO encrypted_note_attachments(id,note_id,keyring_id,version,ciphertext,nonce,
      ciphertext_bytes,object_key,created_at,updated_at) VALUES ('attach','note-a','notes',1,'meta','nonce',17,'obj','now','now')`);
    page = await d.sync(page.cursor);
    assert.equal(page.changes[0].note.attachmentCount, 1);
    d.sql.exec("UPDATE encrypted_note_attachments SET revision=2 WHERE id='attach'");
    page = await d.sync(page.cursor);
    assert.equal(page.changes[0].id, "note-a");
    d.sql.exec("DELETE FROM encrypted_notes WHERE id='note-a'");
    page = await d.sync(page.cursor);
    assert.deepEqual(page.changes, [{ kind: "note", id: "note-a", deleted: true }]);
  } finally { d.sql.close(); }
});

test("pagination converges when entities change or disappear between pages", async () => {
  const d = database();
  try {
    for (let i = 0; i < 205; i++) d.note(`note-${i}`);
    const map = new Map();
    let page = await d.sync();
    assert.equal(page.hasMore, true);
    assert.equal(page.changes.length, 100);
    for (const c of page.changes) map.set(c.id, c.note);
    d.sql.exec("UPDATE encrypted_notes SET ciphertext='updated' WHERE id IN ('note-0','note-150')");
    d.sql.exec("DELETE FROM encrypted_notes WHERE id IN ('note-1','note-151')");
    d.note("late-note");
    while (page.hasMore) {
      page = await d.sync(page.cursor);
      for (const c of page.changes) { if (c.deleted) map.delete(c.id); else map.set(c.id, c.note); }
    }
    assert.equal(map.size, 204);
    assert.equal(map.get("note-0").ciphertext, "updated");
    assert.equal(map.get("note-150").ciphertext, "updated");
    assert.equal(map.has("note-1"), false);
    assert.equal(map.has("note-151"), false);
    assert.equal(map.has("late-note"), true);
    assert.deepEqual((await d.sync(page.cursor)).changes, []);
  } finally { d.sql.close(); }
});

test("pages have a byte budget and invalid/foreign/ahead cursors rebuild", async () => {
  const d = database();
  try {
    d.note("large-a", "a".repeat(2_100_000));
    d.note("large-b", "b".repeat(2_100_000));
    const first = await d.sync();
    assert.equal(first.hasMore, true);
    assert.equal(first.changes.length, 1);
    const last = await d.sync(first.cursor);
    assert.equal(last.hasMore, false);
    assert.equal(last.changes.length, 1);
    for (const cursor of ["broken", "0".repeat(32) + ":1", first.cursor.split(":")[0] + ":99999"]) {
      assert.equal((await d.sync(cursor)).reset, true);
    }
    d.sql.exec("UPDATE notes_sync_epoch SET epoch=lower(hex(randomblob(16)))");
    assert.equal((await d.sync(last.cursor)).reset, true);
  } finally { d.sql.close(); }
});

test("a rolled-back write cannot advance the sync cursor", async () => {
  const d = database();
  try {
    d.note("stable");
    const before = await d.sync();
    d.sql.exec("BEGIN; UPDATE encrypted_notes SET ciphertext='uncommitted'; ROLLBACK;");
    const after = await d.sync(before.cursor);
    assert.equal(after.cursor, before.cursor);
    assert.deepEqual(after.changes, []);
  } finally { d.sql.close(); }
});

test("sync endpoint requires an authenticated admin session", async () => {
  const response = await worker.fetch(new Request("https://notes.test/api/admin/notes-sync"), {}, {});
  assert.equal(response.status, 401);
  assert.match(response.headers.get("Cache-Control"), /no-store/);
});
