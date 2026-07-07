import assert from "node:assert/strict";
import test from "node:test";
import worker, { cacheControlFor } from "../src/worker.js";

test("sets short browser cache and long edge cache for HTML", () => {
  assert.equal(
    cacheControlFor("/", "text/html; charset=utf-8"),
    "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
  );
});

test("sets short cache for dynamic blog content", () => {
  assert.equal(cacheControlFor("/blog/", "text/html; charset=utf-8"), "public, max-age=60, s-maxage=60");
  assert.equal(cacheControlFor("/blog/my-post", "text/html; charset=utf-8"), "public, max-age=60, s-maxage=60");
  assert.equal(cacheControlFor("/category/cloudflare", "text/html; charset=utf-8"), "public, max-age=60, s-maxage=60");
  assert.equal(cacheControlFor("/p/about", "text/html; charset=utf-8"), "public, max-age=60, s-maxage=60");
});

test("sets immutable cache for fingerprinted static assets", () => {
  assert.equal(
    cacheControlFor("/assets/solar-system.20260706.js", "application/javascript"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(
    cacheControlFor("/vendor/three-0.160.0.module.js", "application/javascript"),
    "public, max-age=31536000, immutable",
  );
});

test("adds security headers to asset responses", async () => {
  const env = {
    ASSETS: {
      async fetch() {
        return new Response("<!doctype html><title>ok</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
    },
  };

  const response = await worker.fetch(new Request("https://superstar1014.qzz.io/"), env);

  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.match(response.headers.get("Strict-Transport-Security"), /max-age=31536000/);
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self'/);
});

test("serves custom HTML 404 through the same header policy", async () => {
  const env = {
    ASSETS: {
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/404") {
          return new Response("<!doctype html><title>missing</title>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        return new Response("missing", { status: 404 });
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://superstar1014.qzz.io/missing", {
      headers: { Accept: "text/html" },
    }),
    env,
  );

  assert.equal(response.status, 404);
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
  );
  assert.match(await response.text(), /missing/);
});
