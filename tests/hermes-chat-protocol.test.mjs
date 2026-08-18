import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHermesChatDeliveryFrame,
  createHermesChatMultiplexTicket,
  createHermesChatTicket,
  parseHermesChatFrame,
  planHermesChatAgentAdmission,
  validateHermesChatAction,
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

test("lets the same Hermes agent replace its active connection", () => {
  const active = fakeAgentSocket({
    role: "agent",
    spaceId: "primary",
    userId: "nas-primary",
    connectionId: "old-primary",
  });
  const closing = fakeAgentSocket({
    readyState: 2,
    role: "agent",
    spaceId: "primary",
    userId: "nas-secondary",
  });
  const superseded = fakeAgentSocket({
    role: "agent",
    spaceId: "primary",
    userId: "nas-secondary",
    replacedByConnectionId: "new-primary",
  });
  const closed = fakeAgentSocket({ readyState: 3, attachmentError: true });

  const admission = planHermesChatAgentAdmission(
    [active, superseded, closing, closed],
    { spaceId: "primary", agentId: "nas-primary" },
  );

  assert.equal(admission.conflict, false);
  assert.deepEqual(admission.replacementConnections, [active]);
});

test("keeps a different or unidentified active Hermes agent connected", () => {
  const matching = fakeAgentSocket({
    role: "agent",
    spaceId: "primary",
    userId: "nas-primary",
  });
  const different = fakeAgentSocket({
    role: "agent",
    spaceId: "primary",
    userId: "nas-secondary",
  });
  const unreadable = fakeAgentSocket({ attachmentError: true });

  assert.deepEqual(
    planHermesChatAgentAdmission(
      [matching, different],
      { spaceId: "primary", agentId: "nas-primary" },
    ),
    { conflict: true, replacementConnections: [] },
  );
  assert.deepEqual(
    planHermesChatAgentAdmission(
      [unreadable],
      { spaceId: "primary", agentId: "nas-primary" },
    ),
    { conflict: true, replacementConnections: [] },
  );
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

test("routes encrypted client actions without changing the message envelope", () => {
  const message = {
    v: 1,
    type: "message",
    id: "550e8400-e29b-41d4-a716-446655440020",
    sender: "client",
    sentAt: 1_800_000_000_020,
    encrypted: {
      alg: "A256GCM",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA",
    },
  };
  const frame = { v: 1, type: "action", message };

  assert.deepEqual(validateHermesChatAction(frame, "client"), frame);
  assert.throws(() => validateHermesChatAction(frame, "agent"), /only Hermes chat clients/i);
  assert.throws(
    () => validateHermesChatAction({ ...frame, message: { ...message, sender: "agent" } }, "client"),
    /sender/i,
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

function fakeAgentSocket({ readyState = 1, attachmentError = false, ...attachment }) {
  return {
    readyState,
    deserializeAttachment() {
      if (attachmentError) throw new Error("attachment unavailable");
      return attachment;
    },
  };
}
