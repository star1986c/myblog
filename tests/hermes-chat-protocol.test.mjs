import assert from "node:assert/strict";
import test from "node:test";
import {
  createHermesChatTicket,
  hasConnectedHermesChatAgent,
  parseHermesChatFrame,
  validateHermesChatMessage,
  validateHermesChatReceipt,
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
    token: `${ticket.slice(0, -1)}x`,
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
