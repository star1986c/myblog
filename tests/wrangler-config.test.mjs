import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrangler = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);

test("deployment config binds the existing private notes R2 bucket", () => {
  assert.equal(wrangler.d1_databases[0].binding, "BLOG_DB");
  assert.deepEqual(wrangler.r2_buckets, [
    { binding: "NOTE_ATTACHMENTS", bucket_name: "notes" },
  ]);
});

test("deployment requires both session and notes-key secrets", () => {
  assert.deepEqual(
    [...wrangler.secrets.required].sort(),
    ["NOTES_KEY_ENCRYPTION_SECRET", "SESSION_SECRET"],
  );
});
