import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrangler = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);

test("deployment config uses D1 without requiring R2", () => {
  assert.equal(Object.hasOwn(wrangler, "r2_buckets"), false);
  assert.equal(wrangler.d1_databases[0].binding, "BLOG_DB");
});

test("deployment requires both session and notes-key secrets", () => {
  assert.deepEqual(
    [...wrangler.secrets.required].sort(),
    ["NOTES_KEY_ENCRYPTION_SECRET", "SESSION_SECRET"],
  );
});
