import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHermesChatDeliveryFrame,
  createHermesChatMultiplexTicket,
  createHermesChatTicket,
  hasConnectedHermesChatAgent,
  parseHermesChatFrame,
  validateHermesChatEdit,
  validateHermesChatMessage,
  validateHermesChatReceipt,
  verifyHermesChatMultiplexTicket,
  verifyHermesChatTicket,
} from "../src/hermes-chat-protocol.js";
import {
  configuredHermesChatProfiles,
  requireConfiguredHermesChatSpace,
} from "../src/hermes-chat-gateway.js";

test("allows only one connected agent in each chat space", () => {
  assert.equal(hasConnectedHermesChatAgent([]), false);
  assert.equal(hasConnectedHermesChatAgent(["nas-primary"]), true);
  assert.equal(hasConnectedHermesChatAgent(["nas-secondary"]), true);
  assert.equal(hasConnectedHermesChatAgent([null]), true);
});

test("maps configured Hermes profiles to separate chat spaces", () => {
  const env = {
    HERMES_CHAT_PROFILES: "primary:Hermes 主助手,secondary:Hermes 第二助手",
  };
  assert.deepEqual(configuredHermesChatProfiles(env), [
    { id: "primary", label: "Hermes 主助手" },
    { id: "secondary", label: "Hermes 第二助手" },
  ]);
  assert.equal(requireConfiguredHermesChatSpace(env, "secondary").id, "secondary");
  assert.throws(
    () => requireConfiguredHermesChatSpace(env, "unconfigured"),
    /unavailable/i,
  );
});

test("issues a short-lived Hermes chat ticket bound to one space", async () => {
  const now = 1_800_000_000_000;
  const ticket = await createHermesChatTicket({
    secret: "test-session-secret",
    username: "star",
    spaceId: "default",
    now,
  });
  const payload = await verifyHermesChatTicket({
    token: ticket,
    secret: "test-session-secret",
    now: now + 30_000,
  });

  assert.equal(payload.username, "star");
  assert.equal(payload.spaceId, "default");
  assert.equal(payload.exp - payload.iat, 90);
  assert.match(payload.jti, /^[0-9a-f-]{36}$/);
});

test("rejects expired and tampered Hermes chat tickets", async () => {
  const now = 1_800_000_000_000;
  const ticket = await createHermesChatTicket({
    secret: "test-session-secret",
    username: "star",
    spaceId: "default",
    now,
  });

  assert.equal(await verifyHermesChatTicket({
    token: ticket,
    secret: "test-session-secret",
    now: now + 91_000,
  }), null);
  assert.equal(await verifyHermesChatTicket({
    token: `${ticket.slice(0, -1)}${ticket.endsWith("x") ? "y" : "x"}`,
    secret: "test-session-secret",
    now,
  }), null);
});

test("issues a short-lived multiplex ticket bound to a deduplicated profile list", async () => {
  const now = 1_800_000_000_000;
  const token = await createHermesChatMultiplexTicket({
    secret: "test-session-secret",
    username: "star",
    spaceIds: ["primary", "personal", "primary"],
    now,
  });
  const payload = await verifyHermesChatMultiplexTicket({
    token,
    secret: "test-session-secret",
    now: now + 30_000,
  });

  assert.equal(payload.username, "star");
  assert.deepEqual(payload.spaceIds, ["primary", "personal"]);
  assert.equal(payload.sub, "hermes-chat-multiplex-client");
  assert.equal(payload.exp - payload.iat, 90);
  assert.equal(await verifyHermesChatTicket({
    token,
    secret: "test-session-secret",
    now,
  }), null);
});

test("accepts only bounded encrypted Hermes chat messages", () => {
  const frame = {
    v: 1,
    type: "message",
    id: "550e8400-e29b-41d4-a716-446655440000",
    sender: "client",
    sentAt: 1_800_000_000_000,
    encrypted: {
      alg: "A256GCM",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
    },
  };

  assert.deepEqual(
    validateHermesChatMessage(parseHermesChatFrame(JSON.stringify(frame)), "client"),
    frame,
  );
  assert.throws(() => validateHermesChatMessage(frame, "agent"), /sender/i);
  assert.throws(
    () => parseHermesChatFrame("x".repeat(65 * 1024)),
    /too large/i,
  );
});

test("accepts consumption receipts only from an agent with a valid sequence", () => {
  assert.equal(validateHermesChatReceipt({ v: 1, type: "received", seq: 42 }, "agent"), 42);
  assert.throws(
    () => validateHermesChatReceipt({ v: 1, type: "received", seq: 42 }, "client"),
    /only Hermes agents/i,
  );
  assert.throws(
    () => validateHermesChatReceipt({ v: 1, type: "received", seq: 0 }, "agent"),
    /sequence/i,
  );
});

test("accepts encrypted stream edits only from the Hermes agent", () => {
  const message = {
    v: 1,
    type: "message",
    id: "550e8400-e29b-41d4-a716-446655440010",
    sender: "agent",
    sentAt: 1_800_000_000_100,
    encrypted: {
      alg: "A256GCM",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
    },
  };
  const frame = {
    v: 1,
    type: "edit",
    targetSeq: 42,
    final: true,
    message,
  };

  assert.deepEqual(validateHermesChatEdit(frame, "agent"), frame);
  assert.throws(() => validateHermesChatEdit(frame, "client"), /only Hermes agents/i);
  assert.throws(
    () => validateHermesChatEdit({ ...frame, targetSeq: 0 }, "agent"),
    /target sequence/i,
  );
  assert.throws(
    () => validateHermesChatEdit({ ...frame, final: "yes" }, "agent"),
    /final flag/i,
  );
});

test("replays durable stream finals as edits while preserving their sequence", () => {
  const stored = {
    v: 1,
    type: "edit",
    targetSeq: 42,
    final: true,
    message: {
      v: 1,
      type: "message",
      id: "550e8400-e29b-41d4-a716-446655440011",
      sender: "agent",
      sentAt: 1_800_000_000_200,
      encrypted: {
        alg: "A256GCM",
        nonce: "AAECAwQFBgcICQoL",
        ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
      },
    },
  };

  assert.deepEqual(buildHermesChatDeliveryFrame(stored, 43, true), {
    ...stored,
    seq: 43,
    replayed: true,
  });
});
