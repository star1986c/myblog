import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrangler = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);

test("deployment config does not require R2 for the initial blog backend", () => {
  assert.equal(Object.hasOwn(wrangler, "r2_buckets"), false);
  assert.equal(wrangler.d1_databases[0].binding, "BLOG_DB");
});
