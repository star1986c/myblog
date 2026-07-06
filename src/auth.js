const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HASH_ALGORITHM = "pbkdf2_sha256";
const DEFAULT_ITERATIONS = 210_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const SESSION_COOKIE = "site_admin_session";

async function createPasswordHash(password, options = {}) {
  const iterations = options.iterations || DEFAULT_ITERATIONS;
  const salt = options.salt || randomBytes(SALT_BYTES);
  const hash = await derivePbkdf2(password, salt, iterations);

  return [
    HASH_ALGORITHM,
    String(iterations),
    bytesToBase64Url(salt),
    bytesToBase64Url(hash),
  ].join("$");
}

async function verifyPasswordHash(password, storedHash) {
  const parts = typeof storedHash === "string" ? storedHash.split("$") : [];
  if (parts.length !== 4 || parts[0] !== HASH_ALGORITHM) {
    return false;
  }

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return false;
  }

  let salt;
  let expected;
  try {
    salt = base64UrlToBytes(parts[2]);
    expected = base64UrlToBytes(parts[3]);
  } catch {
    return false;
  }

  const actual = await derivePbkdf2(password, salt, iterations, expected.byteLength);
  return constantTimeEqual(actual, expected);
}

async function signSession({
  secret,
  username,
  csrfToken,
  now = Date.now(),
  maxAgeSeconds = SESSION_MAX_AGE_SECONDS,
}) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    sub: "admin",
    username,
    csrfToken: csrfToken || bytesToBase64Url(randomBytes(24)),
    iat: issuedAt,
    exp: issuedAt + maxAgeSeconds,
  };
  const payloadPart = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signaturePart = bytesToBase64Url(await hmacSha256(secret, payloadPart));
  const token = `${payloadPart}.${signaturePart}`;

  return [
    `${SESSION_COOKIE}=${token}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

async function readSession({ cookieHeader, secret, now = Date.now() }) {
  if (!cookieHeader || !secret) {
    return null;
  }

  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) {
    return null;
  }

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const actualSignature = await hmacSha256(secret, payloadPart);
  let expectedSignature;
  try {
    expectedSignature = base64UrlToBytes(signaturePart);
  } catch {
    return null;
  }

  if (!constantTimeEqual(actualSignature, expectedSignature)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(payloadPart)));
  } catch {
    return null;
  }

  if (payload?.sub !== "admin" || typeof payload.username !== "string") {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(now / 1000)) {
    return null;
  }

  return payload;
}

function clearSessionCookie() {
  return [
    `${SESSION_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

async function derivePbkdf2(password, salt, iterations, byteLength = HASH_BYTES) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    key,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function readCookie(cookieHeader, name) {
  const prefix = `${name}=`;
  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return "";
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function constantTimeEqual(left, right) {
  const maxLength = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength ^ right.byteLength;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

export {
  SESSION_COOKIE,
  clearSessionCookie,
  createPasswordHash,
  readSession,
  signSession,
  verifyPasswordHash,
};
