import { ServiceError } from "./blog-repository.js";

const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_ACTIVE_TOKENS = 5;
const encoder = new TextEncoder();

async function issueDeviceToken(db, accountID, { now = new Date() } = {}) {
  const id = base64Url(randomBytes(16));
  const secret = base64Url(randomBytes(32));
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_MAX_AGE_MS).toISOString();
  await cleanDeviceTokens(db, accountID, createdAt);
  await db
    .prepare(
      `INSERT INTO admin_device_tokens (
         id, account_id, token_hash, expires_at, last_used_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, accountID, await sha256Hex(secret), expiresAt, createdAt, createdAt)
    .run();
  return `${id}.${secret}`;
}

async function rotateDeviceToken(db, token, { now = new Date() } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const stored = await db
    .prepare(
      `SELECT id, account_id AS accountId, token_hash AS tokenHash,
              expires_at AS expiresAt
       FROM admin_device_tokens
       WHERE id = ?`,
    )
    .bind(parsed.id)
    .first();
  if (!stored || stored.expiresAt <= now.toISOString()) {
    if (stored) await revokeDeviceToken(db, token);
    return null;
  }
  const suppliedHash = await sha256Hex(parsed.secret);
  if (!constantTimeEqual(suppliedHash, stored.tokenHash)) return null;

  const nextSecret = base64Url(randomBytes(32));
  const nextHash = await sha256Hex(nextSecret);
  const usedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_MAX_AGE_MS).toISOString();
  const result = await db
    .prepare(
      `UPDATE admin_device_tokens
       SET token_hash = ?, expires_at = ?, last_used_at = ?
       WHERE id = ? AND token_hash = ?`,
    )
    .bind(nextHash, expiresAt, usedAt, parsed.id, stored.tokenHash)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  return {
    accountId: stored.accountId,
    token: `${parsed.id}.${nextSecret}`,
  };
}

async function revokeDeviceToken(db, token) {
  const parsed = parseToken(token);
  if (!parsed) return;
  const suppliedHash = await sha256Hex(parsed.secret);
  await db
    .prepare("DELETE FROM admin_device_tokens WHERE id = ? AND token_hash = ?")
    .bind(parsed.id, suppliedHash)
    .run();
}

async function revokeAllDeviceTokens(db, accountID) {
  await db
    .prepare("DELETE FROM admin_device_tokens WHERE account_id = ?")
    .bind(accountID)
    .run();
}

async function cleanDeviceTokens(db, accountID, nowISO) {
  await db.prepare("DELETE FROM admin_device_tokens WHERE expires_at <= ?").bind(nowISO).run();
  await db
    .prepare(
      `DELETE FROM admin_device_tokens
       WHERE account_id = ?
         AND id NOT IN (
           SELECT id FROM admin_device_tokens
           WHERE account_id = ?
           ORDER BY last_used_at DESC
           LIMIT ?
         )`,
    )
    .bind(accountID, accountID, MAX_ACTIVE_TOKENS - 1)
    .run();
}

function bearerToken(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function requireBearerToken(request) {
  const token = bearerToken(request);
  if (!token) throw new ServiceError("Device token required.", 401);
  return token;
}

function parseToken(value) {
  if (typeof value !== "string" || value.length > 160) return null;
  const [id, secret, extra] = value.split(".");
  if (extra || !/^[A-Za-z0-9_-]{22}$/.test(id || "")
    || !/^[A-Za-z0-9_-]{43}$/.test(secret || "")) return null;
  return { id, secret };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export {
  bearerToken,
  issueDeviceToken,
  requireBearerToken,
  revokeAllDeviceTokens,
  revokeDeviceToken,
  rotateDeviceToken,
};
