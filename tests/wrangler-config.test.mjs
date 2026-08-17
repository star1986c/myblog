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
    ["HERMES_CHAT_AGENT_SECRET", "NOTES_KEY_ENCRYPTION_SECRET", "SESSION_SECRET"],
  );
});

test("deployment config binds the Hermes chat Durable Object", () => {
  assert.equal(wrangler.main, "./src/cloudflare-entry.js");
  assert.deepEqual(wrangler.durable_objects.bindings, [
    { name: "HERMES_CHAT_ROOMS", class_name: "HermesChatRoom" },
  ]);
  assert.deepEqual(wrangler.migrations, [
    { tag: "v1-hermes-chat-room", new_sqlite_classes: ["HermesChatRoom"] },
  ]);
  assert.equal(
    wrangler.vars.HERMES_CHAT_PROFILES,
    "primary:Hermes 主助手,secondary:Hermes 第二助手,personal:Hermes 个人助手",
  );
  assert.equal(wrangler.vars.HERMES_CHAT_CLOUD_RETENTION_DAYS, "30");
  assert.equal(wrangler.compatibility_date, "2026-08-17");
  assert.deepEqual(wrangler.routes, [
    { pattern: "superstar1014.qzz.io", custom_domain: true },
    { pattern: "h.superstar1014.qzz.io", custom_domain: true },
  ]);
});
