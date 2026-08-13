import assert from "node:assert/strict";
import test from "node:test";
import { readOrCreateWorkspaceDataKey } from "../src/workspace-key-repository.js";

class KeyringDb {
  constructor() {
    this.row = null;
  }

  prepare(sql) {
    const db = this;
    const statement = {
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
      async first() {
        return sql.includes("FROM workspace_keyrings") ? db.row : null;
      },
      async run() {
        if (sql.includes("INSERT INTO workspace_keyrings")) {
          const [id, version, wrappedKey, nonce, createdAt, updatedAt] = this.params;
          db.row = { id, version, wrappedKey, nonce, createdAt, updatedAt };
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

const SECRET = "workspace-secret-for-tests-that-is-long-and-random-enough";

test("creates one random data key and stores only its authenticated wrapper", async () => {
  const db = new KeyringDb();
  const first = await readOrCreateWorkspaceDataKey(db, SECRET);
  const second = await readOrCreateWorkspaceDataKey(db, SECRET);

  assert.equal(first.version, 1);
  assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(second, first);
  assert.equal(db.row.id, "notes");
  assert.notEqual(db.row.wrappedKey, first.key);
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(first.key));
  assert.doesNotMatch(JSON.stringify(db.row), new RegExp(SECRET));
});

test("fails closed when the Worker wrapping secret is missing or changes", async () => {
  const db = new KeyringDb();
  await assert.rejects(readOrCreateWorkspaceDataKey(db, "short"), /not configured/i);
  await readOrCreateWorkspaceDataKey(db, SECRET);
  await assert.rejects(
    readOrCreateWorkspaceDataKey(db, "a-different-workspace-secret-that-is-also-long-enough"),
    /could not be recovered/i,
  );
});
