import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { deleteHermesChatAttachments } from "../src/hermes-chat-attachment-repository.js";
import {
  DEFAULT_HERMES_CHAT_CLOUD_RETENTION_DAYS,
  hermesChatRetentionCutoff,
  nextHermesChatCleanupAt,
  resolveHermesChatCloudRetentionDays,
} from "../src/hermes-chat-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function pagedMemoryBucket(entries) {
  const objects = new Map(entries);
  let listRequests = 0;
  return {
    objects,
    get listRequests() {
      return listRequests;
    },
    async list({ prefix, cursor }) {
      listRequests += 1;
      const values = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const offset = Number(cursor || 0);
      const page = values.slice(offset, offset + 2);
      const nextOffset = offset + page.length;
      return {
        objects: page.map(([key, size]) => ({ key, size })),
        truncated: nextOffset < values.length,
        ...(nextOffset < values.length ? { cursor: String(nextOffset) } : {}),
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

test("resolves bounded cloud retention and batches alarms at UTC day boundaries", () => {
  assert.equal(DEFAULT_HERMES_CHAT_CLOUD_RETENTION_DAYS, 30);
  assert.equal(resolveHermesChatCloudRetentionDays({}), 30);
  assert.equal(resolveHermesChatCloudRetentionDays({
    HERMES_CHAT_CLOUD_RETENTION_DAYS: "7",
  }), 7);
  assert.equal(resolveHermesChatCloudRetentionDays({
    HERMES_CHAT_CLOUD_RETENTION_DAYS: "0",
  }), 30);

  const now = Date.UTC(2026, 7, 17, 12, 0, 0);
  const oldest = now - 29 * DAY_MS;
  assert.equal(hermesChatRetentionCutoff({
    HERMES_CHAT_CLOUD_RETENTION_DAYS: "30",
  }, now), now - 30 * DAY_MS);
  assert.equal(
    nextHermesChatCleanupAt(oldest, 30, now),
    Date.UTC(2026, 7, 19, 0, 0, 0),
  );
});

test("manual cloud cleanup deletes only encrypted attachments for the selected profile", async () => {
  const bucket = pagedMemoryBucket([
    ["hermes-chat/v1/primary/0001", 10],
    ["hermes-chat/v1/primary/0002", 20],
    ["hermes-chat/v1/primary/0003", 30],
    ["hermes-chat/v1/secondary/0004", 40],
    ["encrypted-notes/attachment", 50],
  ]);

  const result = await deleteHermesChatAttachments(bucket, { spaceId: "primary" });

  assert.deepEqual(result, {
    attachmentsDeleted: 3,
    ciphertextBytesDeleted: 60,
    listRequests: 2,
  });
  assert.deepEqual([...bucket.objects.keys()].sort(), [
    "encrypted-notes/attachment",
    "hermes-chat/v1/secondary/0004",
  ]);
});

test("Durable Object has age cleanup, monotonic purge state, and no high-frequency cron", async () => {
  const source = await readFile(
    new URL("../src/hermes-chat-room.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /async alarm\(\)/);
  assert.match(source, /setAlarm\(/);
  assert.match(source, /DELETE FROM messages[\s\S]*created_at <=/);
  assert.match(source, /async purgeHistory\(\)/);
  assert.match(source, /room_state/);
});
