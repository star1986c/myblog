import assert from "node:assert/strict";
import test from "node:test";
import worker, { lookupVisitorNetworkInfo } from "../src/worker.js";
import { createPasswordHash, readSession, signSession, verifyPasswordHash } from "../src/auth.js";
import { verifyHermesChatTicket } from "../src/hermes-chat-protocol.js";

function bytesToBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

class FakeD1 {
  constructor({
    posts = [],
    pages = [],
    categories = [],
    media = [],
    adminAccount = null,
    settings = {},
    workspaceKeyring = null,
    encryptedNotes = [],
    encryptedFolders = [],
    encryptedAttachments = [],
    noteProtectionKeyring = null,
    deviceTokens = [],
  } = {}) {
    this.posts = posts;
    this.pages = pages;
    this.categories = categories;
    this.media = media;
    this.adminAccount = adminAccount;
    this.workspaceKeyring = workspaceKeyring;
    this.encryptedNotes = encryptedNotes;
    this.encryptedFolders = encryptedFolders;
    this.encryptedAttachments = encryptedAttachments;
    this.noteProtectionKeyring = noteProtectionKeyring;
    this.deviceTokens = deviceTokens;
    this.settings = {
      session_secret: "test-session-secret",
      ...settings,
    };
    this.insertedPosts = [];
    this.insertedMedia = [];
    this.updatedAdminAccount = null;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    const statement = new FakeStatement(this.db, this.sql);
    statement.params = params;
    return statement;
  }

  async all() {
    if (
      this.sql.includes("FROM encrypted_note_attachments")
      && !this.sql.includes("FROM encrypted_notes")
    ) {
      const noteId = this.params.find((value) => (
        typeof value === "string" && value.startsWith("note_")
      ));
      const attachments = noteId
        ? this.db.encryptedAttachments.filter((item) => item.noteId === noteId)
        : this.db.encryptedAttachments;
      if (this.sql.includes("object_key AS objectKey")) {
        return { results: attachments.map((item) => ({ objectKey: item.objectKey })) };
      }
      return { results: attachments };
    }

    if (this.sql.includes("FROM encrypted_note_folders")) {
      const results = this.db.encryptedFolders
        .map((folder, originalIndex) => ({ folder, originalIndex }))
        .sort((left, right) => (
          (left.folder.sortOrder ?? left.originalIndex)
          - (right.folder.sortOrder ?? right.originalIndex)
        ))
        .map(({ folder }) => folder);
      return { results };
    }

    if (this.sql.includes("FROM encrypted_notes")) {
      const notes = this.db.encryptedNotes.filter((note) => {
        if (this.sql.includes("deleted_at IS NOT NULL")) return Boolean(note.deletedAt);
        if (this.sql.includes("deleted_at IS NULL")) return !note.deletedAt;
        return true;
      });
      return {
        results: notes.map((note) => (
          this.sql.includes("AS attachmentCount")
            ? {
                ...note,
                attachmentCount: this.db.encryptedAttachments.filter(
                  (attachment) => attachment.noteId === note.id,
                ).length,
              }
            : note
        )),
      };
    }

    if (this.sql.includes("FROM media_assets")) {
      return { results: this.db.media };
    }

    if (this.sql.includes("FROM pages") && this.sql.includes("visibility = 'public'")) {
      return {
        results: this.db.pages.filter(
          (page) => page.status === "published" && page.visibility === "public",
        ),
      };
    }

    if (this.sql.includes("FROM categories")) {
      return { results: this.db.categories };
    }

    if (this.sql.includes("FROM posts") && this.sql.includes("visibility = 'public'")) {
      return {
        results: this.db.posts.filter(
          (post) => post.status === "published" && post.visibility === "public",
        ),
      };
    }

    if (this.sql.includes("FROM posts")) {
      return { results: this.db.posts };
    }

    return { results: [] };
  }

  async first() {
    if (this.sql.includes("FROM admin_device_tokens")) {
      const [id] = this.params;
      return this.db.deviceTokens.find((item) => item.id === id) || null;
    }

    if (this.sql.includes("FROM encrypted_note_attachments")) {
      if (this.sql.includes("COUNT(*) AS attachmentCount")) {
        const noteId = this.params.find((value) => (
          typeof value === "string" && value.startsWith("note_")
        ));
        const attachments = noteId
          ? this.db.encryptedAttachments.filter((item) => item.noteId === noteId)
          : this.db.encryptedAttachments;
        return {
          attachmentCount: attachments.length,
          ciphertextBytes: attachments.reduce(
            (total, attachment) => total + Number(attachment.ciphertextBytes || 0),
            0,
          ),
        };
      }
      const [id, noteId] = this.params;
      return this.db.encryptedAttachments.find(
        (item) => item.id === id && item.noteId === noteId,
      ) || null;
    }

    if (this.sql.includes("FROM note_protection_keyrings")) {
      return this.db.noteProtectionKeyring;
    }
    if (this.sql.includes("FROM encrypted_note_folders")) {
      if (this.sql.includes("MAX(sort_order)")) {
        const maximum = this.db.encryptedFolders.reduce(
          (value, folder, index) => Math.max(value, folder.sortOrder ?? index),
          -1,
        );
        return { nextSortOrder: maximum + 1 };
      }
      const [id] = this.params;
      const folder = this.db.encryptedFolders.find((item) => item.id === id);
      if (!folder) return null;
      return this.sql.includes("SELECT revision")
        ? { revision: folder.revision || 1, sortOrder: folder.sortOrder ?? 0 }
        : { id: folder.id };
    }

    if (this.sql.includes("FROM encrypted_notes")) {
      const [id] = this.params;
      const note = this.db.encryptedNotes.find((item) => item.id === id);
      return note
        ? {
            revision: note.revision || 1,
            folderId: note.folderId || null,
            isLocked: note.isLocked ? 1 : 0,
            deletedAt: note.deletedAt || null,
          }
        : null;
    }

    if (this.sql.includes("FROM workspace_keyrings")) {
      return this.db.workspaceKeyring;
    }

    if (this.sql.includes("FROM admin_accounts")) {
      return this.db.adminAccount;
    }

    if (this.sql.includes("FROM admin_settings")) {
      const key = this.params[0];
      return this.db.settings[key] ? { value: this.db.settings[key] } : null;
    }

    if (this.sql.includes("FROM posts") && this.sql.includes("slug = ?")) {
      const slug = this.params[0];
      return this.db.posts.find(
        (post) =>
          post.slug === slug &&
          post.status === "published" &&
          post.visibility === "public",
      ) || null;
    }

    return null;
  }

  async run() {
    if (this.sql.includes("INSERT INTO admin_device_tokens")) {
      const [id, accountId, tokenHash, expiresAt, lastUsedAt, createdAt] = this.params;
      this.db.deviceTokens.push({ id, accountId, tokenHash, expiresAt, lastUsedAt, createdAt });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE admin_device_tokens")) {
      const [tokenHash, expiresAt, lastUsedAt, id, previousHash] = this.params;
      let changes = 0;
      this.db.deviceTokens = this.db.deviceTokens.map((item) => {
        if (item.id !== id || item.tokenHash !== previousHash) return item;
        changes += 1;
        return { ...item, tokenHash, expiresAt, lastUsedAt };
      });
      return { success: true, meta: { changes } };
    }

    if (this.sql.includes("DELETE FROM admin_device_tokens")) {
      const previousLength = this.db.deviceTokens.length;
      if (this.sql.includes("expires_at <=")) {
        const [now] = this.params;
        this.db.deviceTokens = this.db.deviceTokens.filter((item) => item.expiresAt > now);
      } else if (this.sql.includes("id = ?") && this.sql.includes("token_hash = ?")) {
        const [id, tokenHash] = this.params;
        this.db.deviceTokens = this.db.deviceTokens.filter(
          (item) => !(item.id === id && item.tokenHash === tokenHash),
        );
      } else if (this.sql.includes("account_id = ?") && !this.sql.includes("NOT IN")) {
        const [accountId] = this.params;
        this.db.deviceTokens = this.db.deviceTokens.filter((item) => item.accountId !== accountId);
      }
      return {
        success: true,
        meta: { changes: previousLength - this.db.deviceTokens.length },
      };
    }

    if (this.sql.includes("INSERT INTO encrypted_note_attachments")) {
      const [
        id, noteId, , version, ciphertext, nonce, isLocked, ciphertextBytes,
        objectKey, createdAt, updatedAt,
      ] = this.params;
      if (this.db.encryptedAttachments.some((item) => item.id === id)) {
        throw new Error("UNIQUE constraint failed");
      }
      this.db.encryptedAttachments.push({
        id,
        noteId,
        version,
        revision: 1,
        ciphertext,
        nonce,
        isLocked: Boolean(isLocked),
        ciphertextBytes,
        objectKey,
        createdAt,
        updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE encrypted_note_attachments")) {
      const [version, ciphertext, nonce, isLocked, updatedAt, id, noteId, , revision] =
        this.params;
      const exists = this.db.encryptedAttachments.some(
        (item) => item.id === id && item.noteId === noteId && item.revision === revision,
      );
      this.db.encryptedAttachments = this.db.encryptedAttachments.map((item) => (
        item.id === id && item.noteId === noteId && exists
          ? {
              ...item,
              version,
              ciphertext,
              nonce,
              isLocked: Boolean(isLocked),
              updatedAt,
              revision: revision + 1,
            }
          : item
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("DELETE FROM encrypted_note_attachments")) {
      const [id, noteId, , revision] = this.params;
      const previousLength = this.db.encryptedAttachments.length;
      this.db.encryptedAttachments = this.db.encryptedAttachments.filter(
        (item) => !(item.id === id && item.noteId === noteId && item.revision === revision),
      );
      return {
        success: true,
        meta: { changes: previousLength === this.db.encryptedAttachments.length ? 0 : 1 },
      };
    }

    if (this.sql.includes("INSERT INTO note_protection_keyrings")) {
      if (this.db.noteProtectionKeyring) throw new Error("UNIQUE constraint failed");
      const [id, version, kdf, iterations, salt, wrappedKey, nonce, createdAt, updatedAt] =
        this.params;
      this.db.noteProtectionKeyring = {
        id, version, kdf, iterations, salt, wrappedKey, nonce,
        revision: 1, createdAt, updatedAt,
      };
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE note_protection_keyrings")) {
      const [version, kdf, iterations, salt, wrappedKey, nonce, updatedAt, id, revision] =
        this.params;
      const exists = this.db.noteProtectionKeyring?.id === id
        && this.db.noteProtectionKeyring.revision === revision;
      if (exists) {
        this.db.noteProtectionKeyring = {
          ...this.db.noteProtectionKeyring,
          version, kdf, iterations, salt, wrappedKey, nonce, updatedAt,
          revision: revision + 1,
        };
      }
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("INSERT INTO encrypted_note_folders")) {
      const [id, , version, ciphertext, nonce, sortOrder, createdAt, updatedAt] = this.params;
      this.db.encryptedFolders.push({
        id,
        version,
        revision: 1,
        ciphertext,
        nonce,
        sortOrder,
        createdAt,
        updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (
      this.sql.includes("UPDATE encrypted_note_folders")
      && this.sql.includes("SET sort_order = ?")
    ) {
      const [sortOrder, id] = this.params;
      let changes = 0;
      this.db.encryptedFolders = this.db.encryptedFolders.map((folder) => {
        if (folder.id !== id) return folder;
        changes += 1;
        return { ...folder, sortOrder };
      });
      return { success: true, meta: { changes } };
    }

    if (this.sql.includes("UPDATE encrypted_note_folders")) {
      const [version, ciphertext, nonce, updatedAt, id, , revision] = this.params;
      const exists = this.db.encryptedFolders.some(
        (folder) => folder.id === id && (folder.revision || 1) === revision,
      );
      this.db.encryptedFolders = this.db.encryptedFolders.map((folder) => (
        folder.id === id && exists
          ? { ...folder, version, ciphertext, nonce, updatedAt, revision: revision + 1 }
          : folder
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("DELETE FROM encrypted_note_folders")) {
      const [id, , revision] = this.params;
      const previousLength = this.db.encryptedFolders.length;
      this.db.encryptedFolders = this.db.encryptedFolders.filter(
        (folder) => !(folder.id === id && (folder.revision || 1) === revision),
      );
      const changed = previousLength !== this.db.encryptedFolders.length;
      if (changed) {
        this.db.encryptedNotes = this.db.encryptedNotes.map((note) => (
          note.folderId === id
            ? { ...note, folderId: null, revision: (note.revision || 1) + 1 }
            : note
        ));
      }
      return { success: true, meta: { changes: changed ? 1 : 0 } };
    }

    if (this.sql.includes("INSERT INTO encrypted_notes")) {
      const [id, , version, ciphertext, nonce, isLocked, createdAt, updatedAt] = this.params;
      this.db.encryptedNotes.unshift({
        id,
        version,
        revision: 1,
        folderId: null,
        ciphertext,
        nonce,
        isLocked: Boolean(isLocked),
        createdAt,
        updatedAt,
        deletedAt: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE encrypted_notes") && this.sql.includes("SET version = ?")) {
      const [version, ciphertext, nonce, isLocked, updatedAt, id, , revision] = this.params;
      const exists = this.db.encryptedNotes.some(
        (note) => note.id === id && !note.deletedAt && (note.revision || 1) === revision,
      );
      this.db.encryptedNotes = this.db.encryptedNotes.map((note) => (
        note.id === id && exists
          ? {
              ...note,
              version,
              ciphertext,
              nonce,
              isLocked: Boolean(isLocked),
              updatedAt,
              revision: revision + 1,
            }
          : note
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("UPDATE encrypted_notes") && this.sql.includes("SET folder_id = ?")) {
      const [folderId, updatedAt, id, , revision] = this.params;
      const exists = this.db.encryptedNotes.some(
        (note) => note.id === id && !note.deletedAt && (note.revision || 1) === revision,
      );
      this.db.encryptedNotes = this.db.encryptedNotes.map((note) => (
        note.id === id && exists
          ? { ...note, folderId, updatedAt, revision: revision + 1 }
          : note
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("UPDATE encrypted_notes") && this.sql.includes("SET deleted_at = NULL")) {
      const [updatedAt, id, , revision] = this.params;
      const exists = this.db.encryptedNotes.some(
        (note) => note.id === id && note.deletedAt && (note.revision || 1) === revision,
      );
      this.db.encryptedNotes = this.db.encryptedNotes.map((note) => (
        note.id === id && exists
          ? { ...note, deletedAt: null, updatedAt, revision: revision + 1 }
          : note
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("UPDATE encrypted_notes") && this.sql.includes("SET deleted_at = ?")) {
      const [deletedAt, updatedAt, id, , revision] = this.params;
      const exists = this.db.encryptedNotes.some(
        (note) => note.id === id && !note.deletedAt && (note.revision || 1) === revision,
      );
      this.db.encryptedNotes = this.db.encryptedNotes.map((note) => (
        note.id === id && exists
          ? { ...note, deletedAt, updatedAt, revision: revision + 1 }
          : note
      ));
      return { success: true, meta: { changes: exists ? 1 : 0 } };
    }

    if (this.sql.includes("DELETE FROM encrypted_notes")) {
      const [id, , revision] = this.params;
      const previousLength = this.db.encryptedNotes.length;
      this.db.encryptedNotes = this.db.encryptedNotes.filter(
        (note) => !(note.id === id && note.deletedAt && (note.revision || 1) === revision),
      );
      return {
        success: true,
        meta: { changes: previousLength === this.db.encryptedNotes.length ? 0 : 1 },
      };
    }

    if (this.sql.includes("INSERT INTO workspace_keyrings")) {
      const [id, version, wrappedKey, nonce, createdAt, updatedAt] = this.params;
      this.db.workspaceKeyring = { id, version, wrappedKey, nonce, createdAt, updatedAt };
    }

    if (this.sql.includes("UPDATE admin_accounts")) {
      const [username, passwordHash, mustChangePassword, updatedAt, id] = this.params;
      this.db.updatedAdminAccount = {
        id,
        username,
        passwordHash,
        mustChangePassword,
        updatedAt,
      };
      this.db.adminAccount = {
        ...this.db.adminAccount,
        ...this.db.updatedAdminAccount,
      };
    }

    if (this.sql.startsWith("INSERT INTO media_assets")) {
      const [id, objectKey, url, filename, contentType, size, alt] = this.params;
      this.db.insertedMedia.push({
        id,
        objectKey,
        url,
        filename,
        contentType,
        size,
        alt,
      });
    }

    if (this.sql.startsWith("INSERT INTO posts")) {
      const [
        id,
        title,
        slug,
        excerpt,
        content,
        status,
        visibility,
        seoTitle,
        seoDescription,
        publishedAt,
      ] = this.params;
      this.db.insertedPosts.push({
        id,
        title,
        slug,
        excerpt,
        content,
        status,
        visibility,
        seoTitle,
        seoDescription,
        publishedAt,
      });
    }

    return { success: true };
  }
}

function makeEnv(overrides = {}) {
  return {
    ADMIN_USERNAME: "star",
    ADMIN_PASSWORD_HASH: "unused",
    SESSION_SECRET: "test-session-secret",
    NOTES_KEY_ENCRYPTION_SECRET: "test-workspace-key-secret-that-is-at-least-32-characters",
    BLOG_DB: new FakeD1(),
    NOTE_ATTACHMENTS: new FakeR2(),
    ASSETS: {
      async fetch() {
        return new Response("missing", { status: 404 });
      },
    },
    IP_INFO_CLIENT_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    IP_INFO_IP_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    AUTH_LOGIN_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    ...overrides,
  };
}

class FakeR2 {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, options });
    return { key, size: bytes.byteLength };
  }

  async get(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.bytes.byteLength,
      body: new Response(stored.bytes).body,
    };
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

function makeVisitorRequest(ip, cf = {}) {
  const request = new Request("https://superstar1014.qzz.io/api/public/ip-info", {
    headers: {
      Accept: "application/json",
      "CF-Connecting-IP": ip,
      "User-Agent": "visitor-network-test",
      "X-AI-Build-Lab-Request": "visitor-network",
    },
  });
  Object.defineProperty(request, "cf", {
    configurable: true,
    value: cf,
  });
  return request;
}

function makeWorldClockRequest() {
  return new Request("https://superstar1014.qzz.io/api/public/time", {
    headers: {
      Accept: "application/json",
      "X-AI-Build-Lab-Request": "world-clock",
    },
  });
}

function makeEncryptedNote(id = "note_12345678", seed = 20) {
  return {
    id,
    version: 1,
    ciphertext: bytesToBase64Url(new Uint8Array(64).fill(seed)),
    nonce: bytesToBase64Url(new Uint8Array(12).fill(seed + 1)),
  };
}

function makeEncryptedFolder(id = "folder_12345678", seed = 40) {
  return {
    id,
    version: 1,
    ciphertext: bytesToBase64Url(new Uint8Array(64).fill(seed)),
    nonce: bytesToBase64Url(new Uint8Array(12).fill(seed + 1)),
  };
}

function makeEncryptedAttachment(id = "attach_12345678", noteId = "note_12345678", seed = 70) {
  return {
    id,
    noteId,
    version: 1,
    ciphertext: bytesToBase64Url(new Uint8Array(96).fill(seed)),
    nonce: bytesToBase64Url(new Uint8Array(12).fill(seed + 1)),
    isLocked: false,
  };
}

function makeMemoryCache() {
  const responses = new Map();
  const keys = [];
  const bodies = [];
  const cacheControls = [];
  return {
    keys,
    bodies,
    cacheControls,
    async match(request) {
      const response = responses.get(String(request.url));
      return response ? response.clone() : undefined;
    },
    async put(request, response) {
      const key = String(request.url);
      keys.push(key);
      bodies.push(await response.clone().text());
      cacheControls.push(response.headers.get("Cache-Control"));
      responses.set(key, response.clone());
    },
  };
}

test("visitor network lookup sends the Cloudflare client IP to IPinfo", async () => {
  let calledUrl = "";
  let authorization = "";
  const request = makeVisitorRequest("8.8.8.8", {
    country: "US",
    asn: 64500,
    asOrganization: "Fallback Network",
  });

  const network = await lookupVisitorNetworkInfo(
    request,
    { IPINFO_TOKEN: "test-ipinfo-token" },
    {
      cache: null,
      fetchImpl: async (url, options) => {
        calledUrl = String(url);
        authorization = new Headers(options.headers).get("Authorization") || "";
        return new Response(JSON.stringify({
          ip: "198.51.100.7",
          country_code: "US",
          country: "United States",
          asn: "AS64501",
          as_name: "Example Network",
        }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );

  assert.equal(calledUrl, "https://api.ipinfo.io/lite/8.8.8.8");
  assert.equal(authorization, "Bearer test-ipinfo-token");
  assert.equal(network.ip, "8.8.8.8");
  assert.equal(network.country, "United States");
  assert.equal(network.countryCode, "US");
  assert.equal(network.asn, "AS64501");
  assert.equal(network.organization, "Example Network");
  assert.equal(network.source, "ipinfo");
  assert.equal(network.cached, false);
});

test("visitor network lookup falls back from IPinfo to IPWhois", async () => {
  const calledProviders = [];
  const request = makeVisitorRequest("8.8.4.4", { country: "US" });

  const network = await lookupVisitorNetworkInfo(request, {}, {
    cache: null,
    fetchImpl: async (url) => {
      const endpoint = String(url);
      if (endpoint.includes("ipinfo.io")) {
        calledProviders.push("ipinfo");
        return new Response("unavailable", { status: 503 });
      }
      calledProviders.push("ipwhois");
      return new Response(JSON.stringify({
        success: true,
        country: "United States",
        country_code: "US",
        region: "California",
        city: "Mountain View",
        connection: { asn: 15169, org: "Google LLC" },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });

  assert.deepEqual(calledProviders, ["ipinfo", "ipwhois"]);
  assert.equal(network.source, "ipwhois");
  assert.equal(network.asn, "AS15169");
  assert.equal(network.organization, "Google LLC");
  assert.equal(network.cached, false);
});

test("visitor network lookup falls back from IPWhois to GeoJS", async () => {
  const calledProviders = [];
  const request = makeVisitorRequest("8.8.4.4", { country: "US" });

  const network = await lookupVisitorNetworkInfo(request, {}, {
    cache: null,
    fetchImpl: async (url) => {
      const endpoint = String(url);
      if (endpoint.includes("ipinfo.io")) {
        calledProviders.push("ipinfo");
        return new Response("unavailable", { status: 503 });
      }
      if (endpoint.includes("ipwho.is")) {
        calledProviders.push("ipwhois");
        return new Response(JSON.stringify({ success: false, message: "limited" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      calledProviders.push("geojs");
      return new Response(JSON.stringify({
        country: "United States",
        country_code: "US",
        asn: 15169,
        organization_name: "Google LLC",
      }), { headers: { "Content-Type": "application/json" } });
    },
  });

  assert.deepEqual(calledProviders, ["ipinfo", "ipwhois", "geojs"]);
  assert.equal(network.source, "geojs");
  assert.equal(network.asn, "AS15169");
  assert.equal(network.organization, "Google LLC");
});

test("visitor network lookup caches provider data without storing the raw IP", async () => {
  const request = makeVisitorRequest("8.8.8.8", { country: "US" });
  const cache = makeMemoryCache();
  const backgroundWrites = [];
  let providerCalls = 0;

  const first = await lookupVisitorNetworkInfo(request, {}, {
    cache,
    ctx: {
      waitUntil(promise) {
        backgroundWrites.push(promise);
      },
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({
        country: "US",
        org: "AS15169 Google LLC",
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  await Promise.all(backgroundWrites);

  const second = await lookupVisitorNetworkInfo(request, {}, {
    cache,
    fetchImpl: async () => {
      throw new Error("cache hit should skip providers");
    },
  });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.source, "ipinfo");
  assert.equal(providerCalls, 1);
  assert.equal(cache.keys.length, 1);
  assert.doesNotMatch(cache.keys[0], /8\.8\.8\.8/);
  assert.doesNotMatch(cache.bodies[0], /8\.8\.8\.8/);
  assert.equal(cache.cacheControls[0], "public, max-age=21600");
});

test("visitor network lookup prefers the original IPv6 header", async () => {
  const request = makeVisitorRequest("1.1.1.1", {
    country: "TW",
  });
  request.headers.set("CF-Connecting-IPv6", "2606:4700:4700::1111");

  const network = await lookupVisitorNetworkInfo(request, {}, {
    cache: null,
    fetchImpl: async () => new Response(
      JSON.stringify({ country: "TW" }),
      { headers: { "Content-Type": "application/json" } },
    ),
  });

  assert.equal(network.ip, "2606:4700:4700::1111");
});

test("visitor network lookup falls back to Cloudflare metadata", async () => {
  const request = makeVisitorRequest("2001:4860:4860::8888", {
    city: "Taipei",
    region: "Taipei City",
    country: "TW",
    asn: 64502,
    asOrganization: "Example ISP",
  });

  const network = await lookupVisitorNetworkInfo(request, {}, {
    cache: null,
    fetchImpl: async () => {
      throw new Error("provider unavailable");
    },
  });

  assert.deepEqual(network, {
    ip: "2001:4860:4860::8888",
    city: "Taipei",
    region: "Taipei City",
    country: "TW",
    countryCode: "TW",
    asn: "AS64502",
    organization: "Example ISP",
    source: "cloudflare",
    cached: false,
  });
});

test("visitor network lookup does not query IPinfo for non-public addresses", async () => {
  let lookupCalled = false;
  const request = makeVisitorRequest("::1", {
    city: "Unrelated edge location",
    country: "US",
    asn: 64504,
    asOrganization: "Unrelated edge network",
  });

  const network = await lookupVisitorNetworkInfo(request, {}, {
    cache: null,
    fetchImpl: async () => {
      lookupCalled = true;
      throw new Error("should not be called");
    },
  });

  assert.equal(lookupCalled, false);
  assert.deepEqual(network, {
    ip: "::1",
    city: "",
    region: "",
    country: "",
    countryCode: "",
    asn: "",
    organization: "",
    source: "cloudflare",
    cached: false,
  });
});

test("public visitor network API rejects requests without the same-origin client header", async () => {
  const request = makeVisitorRequest("1.1.1.1");
  request.headers.delete("X-AI-Build-Lab-Request");

  const response = await worker.fetch(request, makeEnv());

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("public visitor network API rejects cross-site browser requests", async () => {
  const request = makeVisitorRequest("1.1.1.1");
  request.headers.set("Sec-Fetch-Site", "cross-site");

  const response = await worker.fetch(request, makeEnv());

  assert.equal(response.status, 403);
});

test("public visitor network API rate limits repeated callers", async () => {
  const response = await worker.fetch(
    makeVisitorRequest("1.1.1.1"),
    makeEnv({
      IP_INFO_CLIENT_RATE_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    }),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("public visitor network API is never browser-cached and hashes rate-limit keys", async () => {
  const originalFetch = globalThis.fetch;
  const rateLimitKeys = [];
  globalThis.fetch = async () => new Response(JSON.stringify({
    ip: "1.1.1.1",
    city: "Taipei",
    region: "Taipei City",
    country: "TW",
    org: "AS64503 Example ISP",
  }), {
    headers: { "Content-Type": "application/json" },
  });

  try {
    const response = await worker.fetch(
      makeVisitorRequest("1.1.1.1", {
        country: "TW",
      }),
      makeEnv({
        IP_INFO_CLIENT_RATE_LIMITER: {
          async limit({ key }) {
            rateLimitKeys.push(key);
            return { success: true };
          },
        },
        IP_INFO_IP_RATE_LIMITER: {
          async limit({ key }) {
            rateLimitKeys.push(key);
            return { success: true };
          },
        },
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(body.ip, "1.1.1.1");
    assert.equal(body.organization, "Example ISP");
    assert.equal(body.source, "ipinfo");
    assert.equal(body.cached, false);
    assert.equal(rateLimitKeys.length, 2);
    assert.equal(rateLimitKeys.every((key) => !key.includes("1.1.1.1")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public time API returns uncached Cloudflare edge time", async () => {
  const before = Date.now();
  const response = await worker.fetch(makeWorldClockRequest(), makeEnv());
  const after = Date.now();
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.source, "cloudflare-edge");
  assert.ok(body.epochMs >= before && body.epochMs <= after);
  assert.equal(new Date(body.iso).getTime(), body.epochMs);
});

test("public time API rejects requests without its same-origin widget header", async () => {
  const request = makeWorldClockRequest();
  request.headers.delete("X-AI-Build-Lab-Request");

  const response = await worker.fetch(request, makeEnv());

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("former public blog routes redirect to the public home page", async () => {
  const env = makeEnv({
    BLOG_DB: new FakeD1({
      posts: [
        { slug: "draft", status: "draft", visibility: "private" },
        {
          slug: "edge-guide",
          status: "published",
          visibility: "public",
          updatedAt: "2026-07-10T12:00:00.000Z",
        },
      ],
      pages: [{
        slug: "about",
        status: "published",
        visibility: "public",
        updatedAt: "2026-07-09T12:00:00.000Z",
      }],
      categories: [{ slug: "cloudflare", updatedAt: "2026-07-08T12:00:00.000Z" }],
    }),
  });

  for (const path of ["/blog/", "/blog/edge-guide", "/category/cloudflare", "/p/about"]) {
    const response = await worker.fetch(new Request(`https://superstar1014.qzz.io${path}`), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), "/");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("public posts API never returns stored article content", async () => {
  const env = makeEnv({
    BLOG_DB: new FakeD1({
      posts: [
        { id: "1", title: "Draft", slug: "draft", status: "draft", visibility: "public" },
        {
          id: "2",
          title: "Private",
          slug: "private",
          status: "published",
          visibility: "private",
        },
        {
          id: "3",
          title: "Visible",
          slug: "visible",
          status: "published",
          visibility: "public",
        },
      ],
    }),
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/public/posts"),
    env,
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("admin post list requires a valid session", async () => {
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/posts"),
    makeEnv(),
  );

  assert.equal(response.status, 401);
});

test("retired admin pages redirect to the public home page", async () => {
  for (const path of ["/admin", "/admin/"]) {
    const response = await worker.fetch(
      new Request(`https://superstar1014.qzz.io${path}`),
      makeEnv(),
    );
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("Location"), "/", path);
    assert.equal(response.headers.get("Cache-Control"), "no-store", path);
  }
});

test("removed web notes routes return not found without affecting native APIs", async () => {
  for (const path of ["/notes", "/notes/"]) {
    const response = await worker.fetch(
      new Request(`https://superstar1014.qzz.io${path}`, {
        headers: { Accept: "text/html" },
      }),
      makeEnv(),
    );
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("Cache-Control"), "no-store", path);
  }
});

test("password generator uses its canonical trailing-slash route", async () => {
  const redirect = await worker.fetch(
    new Request("https://superstar1014.qzz.io/password"),
    makeEnv(),
  );
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("Location"), "/password/");

  const page = await worker.fetch(
    new Request("https://superstar1014.qzz.io/password/"),
    makeEnv({
      ASSETS: {
        async fetch(request) {
          return new URL(request.url).pathname === "/password/"
            ? new Response("password generator", {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
              })
            : new Response("missing", { status: 404 });
        },
      },
    }),
  );
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "password generator");
});

test("admin login uses the D1 account with a Worker session secret", async () => {
  const passwordHash = await createPasswordHash("default-password", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(3),
  });
  const db = new FakeD1({
    adminAccount: {
      id: "default",
      username: "admin",
      passwordHash,
      mustChangePassword: 1,
    },
  });
  const env = makeEnv({
    ADMIN_USERNAME: undefined,
    ADMIN_PASSWORD_HASH: undefined,
    SESSION_SECRET: "worker-session-secret",
    BLOG_DB: db,
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: "admin",
        password: "default-password",
      }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.username, "admin");
  assert.equal(body.user.mustChangePassword, true);
  const session = await readSession({
    cookieHeader: response.headers.get("Set-Cookie"),
    secret: "worker-session-secret",
    now: Date.now(),
  });
  assert.equal(session.username, "admin");
});

test("Android device token rotates sessions and can be revoked on logout", async () => {
  const passwordHash = await createPasswordHash("default-password", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(9),
  });
  const db = new FakeD1({
    adminAccount: {
      id: "default",
      username: "admin",
      passwordHash,
      mustChangePassword: 0,
    },
  });
  const env = makeEnv({ BLOG_DB: db });
  const login = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "default-password",
        rememberDevice: true,
      }),
    }),
    env,
  );
  assert.equal(login.status, 200);
  const firstToken = (await login.json()).deviceToken;
  assert.match(firstToken, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(db.deviceTokens.length, 1);
  assert.doesNotMatch(JSON.stringify(db.deviceTokens), new RegExp(firstToken.split(".")[1]));

  const refresh = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}` },
    }),
    env,
  );
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.equal(refreshed.user.username, "admin");
  assert.notEqual(refreshed.deviceToken, firstToken);
  assert.match(refresh.headers.get("Set-Cookie"), /^site_admin_session=/);

  const replay = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}` },
    }),
    env,
  );
  assert.equal(replay.status, 401);

  const logout = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshed.deviceToken}` },
    }),
    env,
  );
  assert.equal(logout.status, 200);
  assert.equal(db.deviceTokens.length, 0);
});

test("admin login fails closed when the Worker session secret is missing", async () => {
  const passwordHash = await createPasswordHash("default-password", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(4),
  });
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "default-password" }),
    }),
    makeEnv({
      ADMIN_USERNAME: undefined,
      ADMIN_PASSWORD_HASH: undefined,
      SESSION_SECRET: undefined,
      BLOG_DB: new FakeD1({
        adminAccount: { id: "default", username: "admin", passwordHash, mustChangePassword: 0 },
      }),
    }),
  );

  assert.equal(response.status, 503);
});

test("admin login is rate limited without exposing the username or IP in the limiter key", async () => {
  const passwordHash = await createPasswordHash("default-password", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(6),
  });
  let limiterKey = "";
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/auth/login", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.8",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "admin", password: "default-password" }),
    }),
    makeEnv({
      BLOG_DB: new FakeD1({
        adminAccount: { id: "default", username: "admin", passwordHash, mustChangePassword: 0 },
      }),
      AUTH_LOGIN_RATE_LIMITER: {
        async limit({ key }) {
          limiterKey = key;
          return { success: false };
        },
      },
    }),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.match(limiterKey, /^admin-login:[0-9a-f]{64}$/);
  assert.doesNotMatch(limiterKey, /203\.0\.113\.8/);
});

test("public pages API never returns stored page content", async () => {
  const env = makeEnv({
    BLOG_DB: new FakeD1({
      pages: [
        { id: "1", title: "Draft Page", slug: "draft", status: "draft", visibility: "public" },
        {
          id: "2",
          title: "Private Page",
          slug: "private",
          status: "published",
          visibility: "private",
        },
        {
          id: "3",
          title: "About",
          slug: "about",
          status: "published",
          visibility: "public",
        },
      ],
    }),
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/public/pages"),
    env,
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("admin can change the default account password after login", async () => {
  const passwordHash = await createPasswordHash("old-default-password", {
    iterations: 1000,
    salt: new Uint8Array(16).fill(5),
  });
  const db = new FakeD1({
    adminAccount: {
      id: "default",
      username: "admin",
      passwordHash,
      mustChangePassword: 1,
    },
    deviceTokens: [{
      id: "remembered-device",
      accountId: "default",
      tokenHash: "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastUsedAt: "2026-08-14T00:00:00.000Z",
      createdAt: "2026-08-14T00:00:00.000Z",
    }],
  });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: "admin",
    csrfToken: "csrf-token",
    now: 1_800_000_000_000,
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/account", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify({
        username: "star",
        currentPassword: "old-default-password",
        newPassword: "new-strong-password",
      }),
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(db.updatedAdminAccount.username, "star");
  assert.equal(db.updatedAdminAccount.mustChangePassword, 0);
  assert.equal(await verifyPasswordHash("new-strong-password", db.updatedAdminAccount.passwordHash), true);
  assert.equal(db.deviceTokens.length, 0);
});

test("workspace key API requires an authenticated administrator session", async () => {
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/workspace-key"),
    makeEnv(),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("authenticated Android client lists dynamic Hermes profiles and requests a bound ticket", async () => {
  const env = makeEnv({
    HERMES_CHAT_PROFILES: "primary:主助手,secondary:研究助手,third:代码助手",
  });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "hermes-csrf-token",
  });
  const profilesResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/hermes-chat/profiles", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.deepEqual(await profilesResponse.json(), {
    profiles: [
      { id: "primary", label: "主助手" },
      { id: "secondary", label: "研究助手" },
      { id: "third", label: "代码助手" },
    ],
  });

  const ticketResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/hermes-chat/ticket", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "hermes-csrf-token",
      },
      body: JSON.stringify({ spaceId: "third" }),
    }),
    env,
  );
  const ticketBody = await ticketResponse.json();
  assert.equal(ticketResponse.status, 200);
  assert.equal(ticketBody.spaceId, "third");
  const ticket = await verifyHermesChatTicket({
    token: ticketBody.ticket,
    secret: env.SESSION_SECRET,
  });
  assert.equal(ticket.spaceId, "third");
  assert.equal(ticket.username, env.ADMIN_USERNAME);
});

test("authenticated workspace key is created once and returned without a master password", async () => {
  const db = new FakeD1();
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "workspace-csrf-token",
    now: 1_800_000_000_000,
  });
  const firstResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/workspace-key", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  const firstBody = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  assert.match(firstBody.workspaceKey.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.workspaceKeyring.id, "notes");
  assert.doesNotMatch(JSON.stringify(db.workspaceKeyring), new RegExp(firstBody.workspaceKey.key));

  const secondResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/workspace-key", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.deepEqual(await secondResponse.json(), firstBody);
});

test("retired blog and password-vault admin APIs return not found", async () => {
  const env = makeEnv({ BLOG_DB: new FakeD1() });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "retired-csrf-token",
    now: 1_800_000_000_000,
  });
  for (const path of [
    "/api/admin/password-vault",
    "/api/admin/posts",
    "/api/admin/pages",
    "/api/admin/categories",
    "/api/admin/media",
  ]) {
    const response = await worker.fetch(
      new Request(`https://superstar1014.qzz.io${path}`, { headers: { Cookie: cookie } }),
      env,
    );
    assert.equal(response.status, 404, path);
  }
});

test("administrator stores one wrapped note protection key without a password", async () => {
  const db = new FakeD1();
  const env = makeEnv({ BLOG_DB: db });
  const csrfToken = "protection-csrf-token";
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken,
    now: 1_800_000_000_000,
  });
  const payload = {
    id: "notes-protection",
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 310000,
    salt: bytesToBase64Url(new Uint8Array(16).fill(3)),
    wrappedKey: bytesToBase64Url(new Uint8Array(48).fill(4)),
    nonce: bytesToBase64Url(new Uint8Array(12).fill(5)),
  };
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/note-protection-keyring", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(payload),
    }),
    env,
  );
  assert.equal(response.status, 201);
  assert.equal(db.noteProtectionKeyring.wrappedKey, payload.wrappedKey);
  assert.doesNotMatch(JSON.stringify(db.noteProtectionKeyring), /password|plaintext|content/i);

  const rejected = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/note-protection-keyring", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        "If-Match": '"1"',
      },
      body: JSON.stringify({ ...payload, password: "must-never-upload" }),
    }),
    env,
  );
  assert.equal(rejected.status, 400);
});

test("legacy clients cannot overwrite a server-locked note", async () => {
  const note = { ...makeEncryptedNote(), revision: 1, isLocked: true };
  const db = new FakeD1({ workspaceKeyring: { id: "notes" }, encryptedNotes: [note] });
  const env = makeEnv({ BLOG_DB: db });
  const csrfToken = "locked-note-csrf-token";
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken,
    now: 1_800_000_000_000,
  });
  const changed = makeEncryptedNote(note.id, 91);
  const response = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        "If-Match": '"1"',
      },
      body: JSON.stringify(changed),
    }),
    env,
  );
  assert.equal(response.status, 409);
  assert.equal(db.encryptedNotes[0].ciphertext, note.ciphertext);
});

test("administrator can create, update, trash, restore, and purge encrypted notes", async () => {
  const db = new FakeD1({ workspaceKeyring: { id: "notes" } });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "notes-csrf-token",
    now: 1_800_000_000_000,
  });
  const writeHeaders = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "X-CSRF-Token": "notes-csrf-token",
  };
  const note = makeEncryptedNote();

  const createResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(note),
    }),
    env,
  );
  assert.equal(createResponse.status, 201);
  assert.equal(db.encryptedNotes.length, 1);

  const readResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  const readBody = await readResponse.json();
  assert.equal(readResponse.status, 200);
  assert.deepEqual(readBody.notes.map((item) => item.id), [note.id]);
  assert.doesNotMatch(JSON.stringify(readBody), /title|content|password|username/i);

  const changedNote = makeEncryptedNote(note.id, 30);
  const updateResponse = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "PUT",
      headers: { ...writeHeaders, "If-Match": '"1"' },
      body: JSON.stringify(changedNote),
    }),
    env,
  );
  assert.equal(updateResponse.status, 200);
  assert.equal(db.encryptedNotes[0].ciphertext, changedNote.ciphertext);

  const deleteResponse = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "DELETE",
      headers: { ...writeHeaders, "If-Match": '"2"' },
    }),
    env,
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(db.encryptedNotes.length, 1);
  assert.equal(db.encryptedNotes[0].revision, 3);
  assert.ok(db.encryptedNotes[0].deletedAt);

  const activeAfterDelete = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.deepEqual((await activeAfterDelete.json()).notes, []);

  const trashResponse = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes-trash", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.deepEqual((await trashResponse.json()).notes.map((item) => item.id), [note.id]);

  const restoreResponse = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/restore`, {
      method: "POST",
      headers: { ...writeHeaders, "If-Match": '"3"' },
    }),
    env,
  );
  assert.equal(restoreResponse.status, 200);
  assert.equal(db.encryptedNotes[0].deletedAt, null);
  assert.equal(db.encryptedNotes[0].revision, 4);

  await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "DELETE",
      headers: { ...writeHeaders, "If-Match": '"4"' },
    }),
    env,
  );
  const purgeResponse = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/purge`, {
      method: "DELETE",
      headers: { ...writeHeaders, "If-Match": '"5"' },
    }),
    env,
  );
  assert.equal(purgeResponse.status, 200);
  assert.equal(db.encryptedNotes.length, 0);
});

test("administrator streams encrypted image attachments through private R2 with safety limits", async () => {
  const note = { ...makeEncryptedNote(), revision: 1, deletedAt: null };
  const db = new FakeD1({
    workspaceKeyring: { id: "notes" },
    encryptedNotes: [note],
  });
  const bucket = new FakeR2();
  const env = makeEnv({ BLOG_DB: db, NOTE_ATTACHMENTS: bucket });
  const csrfToken = "attachment-csrf-token";
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken,
    now: 1_800_000_000_000,
  });
  const attachment = makeEncryptedAttachment();
  const encryptedImage = new Uint8Array(128).fill(91);
  const attachmentPath = `/api/admin/encrypted-notes/${note.id}/attachments/${attachment.id}`;

  const emptyNotes = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.equal(emptyNotes.status, 200);
  assert.equal((await emptyNotes.json()).notes[0].attachmentCount, 0);

  const upload = await worker.fetch(
    new Request(`https://superstar1014.qzz.io${attachmentPath}`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(encryptedImage.byteLength),
        "X-Attachment-Version": "1",
        "X-Attachment-Ciphertext": attachment.ciphertext,
        "X-Attachment-Nonce": attachment.nonce,
        "X-Attachment-Locked": "false",
        "X-CSRF-Token": csrfToken,
      },
      body: encryptedImage,
    }),
    env,
  );
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()).attachment;
  assert.equal(uploaded.id, attachment.id);
  assert.equal(uploaded.ciphertextBytes, encryptedImage.byteLength);
  assert.equal(db.encryptedAttachments.length, 1);
  assert.equal(bucket.objects.size, 1);
  assert.doesNotMatch(JSON.stringify(uploaded), /filename|image\/|data_key|plaintext/i);

  const populatedNotes = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.equal(populatedNotes.status, 200);
  assert.equal((await populatedNotes.json()).notes[0].attachmentCount, 1);

  const list = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/attachments`, {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).attachments.map((item) => item.id), [attachment.id]);

  const download = await worker.fetch(
    new Request(`https://superstar1014.qzz.io${attachmentPath}/content`, {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(download.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), encryptedImage);

  const changed = makeEncryptedAttachment(attachment.id, note.id, 80);
  const mismatchedLock = await worker.fetch(
    new Request(`https://superstar1014.qzz.io${attachmentPath}`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "If-Match": '"1"',
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ ...changed, isLocked: true }),
    }),
    env,
  );
  assert.equal(mismatchedLock.status, 409);

  const update = await worker.fetch(
    new Request(`https://superstar1014.qzz.io${attachmentPath}`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "If-Match": '"1"',
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ ...changed, isLocked: false }),
    }),
    env,
  );
  assert.equal(update.status, 200);
  assert.equal((await update.json()).attachment.isLocked, false);
  assert.equal(db.encryptedAttachments[0].revision, 2);

  const usage = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-attachments/usage", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  const usageBody = (await usage.json()).usage;
  assert.equal(usageBody.attachmentCount, 1);
  assert.equal(usageBody.ciphertextBytes, encryptedImage.byteLength);
  assert.equal(usageBody.maxCiphertextBytes, 8 * 1024 * 1024 * 1024);

  const rejected = await worker.fetch(
    new Request(
      `https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/attachments/attach_too_large`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(10 * 1024 * 1024 + 17),
          "X-Attachment-Version": "1",
          "X-Attachment-Ciphertext": attachment.ciphertext,
          "X-Attachment-Nonce": attachment.nonce,
          "X-Attachment-Locked": "false",
          "X-CSRF-Token": csrfToken,
        },
        body: new Uint8Array(17),
      },
    ),
    env,
  );
  assert.equal(rejected.status, 413);
  assert.equal(bucket.objects.size, 1);

  const trash = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, "If-Match": '"1"', "X-CSRF-Token": csrfToken },
    }),
    env,
  );
  assert.equal(trash.status, 200);
  const purge = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/purge`, {
      method: "DELETE",
      headers: { Cookie: cookie, "If-Match": '"2"', "X-CSRF-Token": csrfToken },
    }),
    env,
  );
  assert.equal(purge.status, 200);
  assert.equal(bucket.objects.size, 0);
  assert.equal(db.encryptedNotes.length, 0);
});

test("administrator can manage encrypted folders without changing the legacy note save API", async () => {
  const db = new FakeD1({ workspaceKeyring: { id: "notes" } });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "folders-csrf-token",
    now: 1_800_000_000_000,
  });
  const writeHeaders = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "X-CSRF-Token": "folders-csrf-token",
  };
  const folder = makeEncryptedFolder();

  const createFolder = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(folder),
    }),
    env,
  );
  assert.equal(createFolder.status, 201);
  assert.equal(db.encryptedFolders.length, 1);
  assert.equal(db.encryptedFolders[0].sortOrder, 0);
  assert.doesNotMatch(JSON.stringify(await createFolder.json()), /name|title|content/i);

  const listFolders = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders", {
      headers: { Cookie: cookie },
    }),
    env,
  );
  assert.deepEqual((await listFolders.json()).folders.map((item) => item.id), [folder.id]);

  const note = makeEncryptedNote();
  await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      method: "POST",
      headers: writeHeaders,
      body: JSON.stringify(note),
    }),
    env,
  );

  const moveNote = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}/folder`, {
      method: "PUT",
      headers: { ...writeHeaders, "If-Match": '"1"' },
      body: JSON.stringify({ folderId: folder.id }),
    }),
    env,
  );
  assert.equal(moveNote.status, 200);
  assert.equal((await moveNote.json()).note.folderId, folder.id);
  assert.equal(db.encryptedNotes[0].revision, 2);

  const changedNote = makeEncryptedNote(note.id, 60);
  const legacySave = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "PUT",
      headers: { ...writeHeaders, "If-Match": '"2"' },
      body: JSON.stringify(changedNote),
    }),
    env,
  );
  assert.equal(legacySave.status, 200);
  assert.equal((await legacySave.json()).note.folderId, folder.id);
  assert.equal(db.encryptedNotes[0].folderId, folder.id);
  assert.equal(db.encryptedNotes[0].revision, 3);

  const renamedFolder = makeEncryptedFolder(folder.id, 70);
  const rename = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-note-folders/${folder.id}`, {
      method: "PUT",
      headers: { ...writeHeaders, "If-Match": '"1"' },
      body: JSON.stringify(renamedFolder),
    }),
    env,
  );
  assert.equal(rename.status, 200);
  assert.equal(db.encryptedFolders[0].revision, 2);

  const remove = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-note-folders/${folder.id}`, {
      method: "DELETE",
      headers: { ...writeHeaders, "If-Match": '"2"' },
    }),
    env,
  );
  assert.equal(remove.status, 200);
  assert.equal(db.encryptedFolders.length, 0);
  assert.equal(db.encryptedNotes[0].folderId, null);
  assert.equal(db.encryptedNotes[0].revision, 4);
});

test("administrator can persist a complete encrypted folder order", async () => {
  const timestamp = "2026-08-14T00:00:00.000Z";
  const encryptedFolders = [
    { ...makeEncryptedFolder("folder_alpha", 40), revision: 1, sortOrder: 0, createdAt: timestamp },
    { ...makeEncryptedFolder("folder_bravo", 50), revision: 1, sortOrder: 1, createdAt: timestamp },
    { ...makeEncryptedFolder("folder_charlie", 60), revision: 1, sortOrder: 2, createdAt: timestamp },
  ];
  const db = new FakeD1({ workspaceKeyring: { id: "notes" }, encryptedFolders });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "folder-order-csrf-token",
    now: 1_800_000_000_000,
  });
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "X-CSRF-Token": "folder-order-csrf-token",
  };
  const folderIds = ["folder_charlie", "folder_alpha", "folder_bravo"];

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders/order", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderIds }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).folders.map((folder) => folder.id), folderIds);
  assert.deepEqual(
    db.encryptedFolders.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((folder) => folder.id),
    folderIds,
  );

  const duplicate = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders/order", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderIds: ["folder_alpha", "folder_alpha"] }),
    }),
    env,
  );
  assert.equal(duplicate.status, 400);

  const stale = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders/order", {
      method: "PUT",
      headers,
      body: JSON.stringify({ folderIds: ["folder_alpha", "folder_bravo"] }),
    }),
    env,
  );
  assert.equal(stale.status, 409);
});

test("encrypted folder API rejects plaintext names", async () => {
  const db = new FakeD1({ workspaceKeyring: { id: "notes" } });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "folder-privacy-csrf-token",
    now: 1_800_000_000_000,
  });
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-note-folders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "folder-privacy-csrf-token",
      },
      body: JSON.stringify({ ...makeEncryptedFolder(), name: "must-never-reach-d1" }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(db.encryptedFolders.length, 0);
});

test("encrypted note updates reject stale revisions", async () => {
  const note = { ...makeEncryptedNote(), revision: 4, deletedAt: null };
  const db = new FakeD1({ workspaceKeyring: { id: "notes" }, encryptedNotes: [note] });
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "revision-csrf-token",
    now: 1_800_000_000_000,
  });
  const response = await worker.fetch(
    new Request(`https://superstar1014.qzz.io/api/admin/encrypted-notes/${note.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "revision-csrf-token",
        "If-Match": '"3"',
      },
      body: JSON.stringify(makeEncryptedNote(note.id, 31)),
    }),
    env,
  );
  assert.equal(response.status, 409);
  assert.equal(db.encryptedNotes[0].ciphertext, note.ciphertext);
});

test("encrypted notes API requires authentication, CSRF, and ciphertext-only payloads", async () => {
  const db = new FakeD1({ workspaceKeyring: { id: "notes" } });
  const env = makeEnv({ BLOG_DB: db });
  const note = makeEncryptedNote();

  const unauthenticated = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes"),
    env,
  );
  assert.equal(unauthenticated.status, 401);

  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "notes-csrf-token",
    now: 1_800_000_000_000,
  });
  const missingCsrf = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(note),
    }),
    env,
  );
  assert.equal(missingCsrf.status, 403);

  const plaintext = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/encrypted-notes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "notes-csrf-token",
      },
      body: JSON.stringify({ ...note, title: "must-never-reach-d1" }),
    }),
    env,
  );
  assert.equal(plaintext.status, 400);
  assert.equal(db.encryptedNotes.length, 0);
});
