import assert from "node:assert/strict";
import test from "node:test";
import worker, { lookupVisitorNetworkInfo } from "../src/worker.js";
import { createPasswordHash, readSession, signSession, verifyPasswordHash } from "../src/auth.js";

class FakeD1 {
  constructor({ posts = [], pages = [], media = [], adminAccount = null, settings = {} } = {}) {
    this.posts = posts;
    this.pages = pages;
    this.media = media;
    this.adminAccount = adminAccount;
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
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
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
    BLOG_DB: new FakeD1(),
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
    ...overrides,
  };
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

test("public posts API only returns published and public articles", async () => {
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

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.posts.map((post) => post.slug), ["visible"]);
});

test("admin post list requires a valid session", async () => {
  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/posts"),
    makeEnv(),
  );

  assert.equal(response.status, 401);
});

test("admin login uses the D1 default account without credential secrets", async () => {
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
    settings: {
      session_secret: "db-session-secret",
    },
  });
  const env = makeEnv({
    ADMIN_USERNAME: undefined,
    ADMIN_PASSWORD_HASH: undefined,
    SESSION_SECRET: undefined,
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
    secret: "db-session-secret",
    now: Date.now(),
  });
  assert.equal(session.username, "admin");
});

test("public pages API only returns published and public pages", async () => {
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

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.pages.map((page) => page.slug), ["about"]);
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
});

test("admin-created posts default to draft and private", async () => {
  const db = new FakeD1();
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "csrf-token",
    now: 1_800_000_000_000,
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify({
        title: "Hidden First Draft",
        content: "Not ready yet.",
      }),
    }),
    env,
  );

  assert.equal(response.status, 201);
  assert.equal(db.insertedPosts.length, 1);
  assert.equal(db.insertedPosts[0].status, "draft");
  assert.equal(db.insertedPosts[0].visibility, "private");
  assert.equal(db.insertedPosts[0].slug, "hidden-first-draft");
});

test("admin media records use a manually entered URL without R2", async () => {
  const db = new FakeD1();
  const env = makeEnv({ BLOG_DB: db });
  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username: env.ADMIN_USERNAME,
    csrfToken: "csrf-token",
    now: 1_800_000_000_000,
  });

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/api/admin/media", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": "csrf-token",
      },
      body: JSON.stringify({
        url: "https://cdn.example.com/hero.png",
        alt: "Hero image",
      }),
    }),
    env,
  );

  assert.equal(response.status, 201);
  assert.equal(db.insertedMedia.length, 1);
  assert.equal(db.insertedMedia[0].url, "https://cdn.example.com/hero.png");
  assert.equal(db.insertedMedia[0].objectKey, "https://cdn.example.com/hero.png");
  assert.equal(db.insertedMedia[0].filename, "hero.png");
});
