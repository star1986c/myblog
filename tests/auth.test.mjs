import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_COOKIE,
  createPasswordHash,
  readSession,
  signSession,
  verifyPasswordHash,
} from "../src/auth.js";

test("verifies pbkdf2 password hashes and rejects wrong passwords", async () => {
  const hash = await createPasswordHash("correct horse battery staple", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(7),
  });

  assert.equal(await verifyPasswordHash("correct horse battery staple", hash), true);
  assert.equal(await verifyPasswordHash("wrong password", hash), false);
});

test("signs and reads administrator sessions with csrf token", async () => {
  const cookie = await signSession({
    secret: "test-session-secret",
    username: "star",
    now: 1_800_000_000_000,
    maxAgeSeconds: 3600,
  });

  assert.match(cookie, new RegExp(`${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const session = await readSession({
    cookieHeader: cookie,
    secret: "test-session-secret",
    now: 1_800_000_000_000,
  });

  assert.equal(session.username, "star");
  assert.equal(typeof session.csrfToken, "string");
  assert.ok(session.csrfToken.length >= 24);
});

test("rejects expired sessions", async () => {
  const cookie = await signSession({
    secret: "test-session-secret",
    username: "star",
    now: 1_800_000_000_000,
    maxAgeSeconds: 10,
  });

  const session = await readSession({
    cookieHeader: cookie,
    secret: "test-session-secret",
    now: 1_800_000_011_000,
  });

  assert.equal(session, null);
});
