import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { signSession } from "../src/auth.js";

class FakeD1 {
  constructor({ posts = [], pages = [], media = [] } = {}) {
    this.posts = posts;
    this.pages = pages;
    this.media = media;
    this.insertedPosts = [];
    this.insertedMedia = [];
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
    ...overrides,
  };
}

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
