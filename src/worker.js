import {
  clearSessionCookie,
  readSession,
  signSession,
  verifyPasswordHash,
} from "./auth.js";
import {
  ServiceError,
  createCategory,
  createMediaAsset,
  createPage,
  createPost,
  deleteCategory,
  deletePage,
  deletePost,
  getCategoryBySlug,
  getPublicPageBySlug,
  getPublicPostBySlug,
  listAdminPages,
  listAdminPosts,
  listCategories,
  listMediaAssets,
  listPublicPages,
  listPublicPosts,
  listPublicPostsByCategory,
  requireDatabase,
  updateCategory,
  updatePage,
  updatePost,
} from "./blog-repository.js";
import {
  renderBlogIndex,
  renderBlogNotConfigured,
  renderCategory,
  renderPost,
  renderStandalonePage,
} from "./blog-render.js";

const IMMUTABLE_ASSET_PATH = /^\/(?:assets|vendor)\//;
const MAX_MEDIA_UPLOAD_BYTES = 5 * 1024 * 1024;

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return withSiteHeaders(request, errorResponse(request, error));
    }
  },
};

async function handleRequest(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return withSiteHeaders(request, await handleApiRequest(request, env));
    }

    if (url.pathname.startsWith("/media/")) {
      return withSiteHeaders(request, await handleMediaRequest(request, env));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSiteHeaders(request, new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }));
    }

    if (url.pathname === "/blog" || url.pathname === "/blog/") {
      return withSiteHeaders(request, await renderBlogIndexResponse(request, env));
    }

    if (url.pathname.startsWith("/blog/")) {
      return withSiteHeaders(request, await renderPostResponse(request, env, url));
    }

    if (url.pathname.startsWith("/category/")) {
      return withSiteHeaders(request, await renderCategoryResponse(request, env, url));
    }

    if (url.pathname.startsWith("/p/")) {
      return withSiteHeaders(request, await renderPageResponse(request, env, url));
    }

    let response = await env.ASSETS.fetch(request);

    if (response.status === 404 && acceptsHtml(request) && url.pathname !== "/404.html") {
      const notFoundUrl = new URL(request.url);
      notFoundUrl.pathname = "/404";
      notFoundUrl.search = "";
      const notFoundRequest = new Request(notFoundUrl, request);
      const notFoundResponse = await env.ASSETS.fetch(notFoundRequest);
      response = new Response(notFoundResponse.body, {
        status: 404,
        statusText: "Not Found",
        headers: notFoundResponse.headers,
      });
    }

    return withSiteHeaders(request, response);
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = trimTrailingSlash(url.pathname);

  if (path === "/api/auth/me" && request.method === "GET") {
    const session = await readAdminSession(request, env);
    return jsonResponse({
      authenticated: Boolean(session),
      user: session ? { username: session.username } : null,
      csrfToken: session?.csrfToken || null,
    });
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    return await handleLogin(request, env);
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return jsonResponse(
      { ok: true },
      {
        headers: {
          "Set-Cookie": clearSessionCookie(),
        },
      },
    );
  }

  if (path === "/api/public/posts" && request.method === "GET") {
    const db = requireDatabase(env);
    return jsonResponse({ posts: await listPublicPosts(db) });
  }

  if (path === "/api/public/pages" && request.method === "GET") {
    const db = requireDatabase(env);
    return jsonResponse({ pages: await listPublicPages(db) });
  }

  if (path.startsWith("/api/public/posts/") && request.method === "GET") {
    const db = requireDatabase(env);
    const post = await getPublicPostBySlug(db, decodeURIComponent(path.slice("/api/public/posts/".length)));
    return post ? jsonResponse({ post }) : jsonResponse({ error: "Not found" }, { status: 404 });
  }

  if (path.startsWith("/api/public/pages/") && request.method === "GET") {
    const db = requireDatabase(env);
    const page = await getPublicPageBySlug(db, decodeURIComponent(path.slice("/api/public/pages/".length)));
    return page ? jsonResponse({ page }) : jsonResponse({ error: "Not found" }, { status: 404 });
  }

  if (path.startsWith("/api/admin/")) {
    return await handleAdminApi(request, env, path);
  }

  return jsonResponse({ error: "Not found" }, { status: 404 });
}

async function handleLogin(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
    return jsonResponse({ error: "Authentication is not configured." }, { status: 503 });
  }

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const passwordMatches = await verifyPasswordHash(password, env.ADMIN_PASSWORD_HASH);

  if (username !== env.ADMIN_USERNAME || !passwordMatches) {
    return jsonResponse({ error: "Invalid username or password." }, { status: 401 });
  }

  const cookie = await signSession({
    secret: env.SESSION_SECRET,
    username,
  });
  const session = await readSession({
    cookieHeader: cookie,
    secret: env.SESSION_SECRET,
  });

  return jsonResponse(
    {
      ok: true,
      user: { username },
      csrfToken: session.csrfToken,
    },
    {
      headers: {
        "Set-Cookie": cookie,
      },
    },
  );
}

async function handleAdminApi(request, env, path) {
  const session = await readAdminSession(request, env);
  if (!session) {
    return jsonResponse({ error: "Authentication required." }, { status: 401 });
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    const csrfToken = request.headers.get("X-CSRF-Token") || "";
    if (csrfToken !== session.csrfToken) {
      return jsonResponse({ error: "Invalid CSRF token." }, { status: 403 });
    }
  }

  const db = requireDatabase(env);

  if (path === "/api/admin/posts") {
    if (request.method === "GET") {
      return jsonResponse({ posts: await listAdminPosts(db) });
    }
    if (request.method === "POST") {
      return jsonResponse({ post: await createPost(db, await readJson(request)) }, { status: 201 });
    }
  }

  if (path.startsWith("/api/admin/posts/")) {
    const id = decodeURIComponent(path.slice("/api/admin/posts/".length));
    if (request.method === "PUT") {
      return jsonResponse({ post: await updatePost(db, id, await readJson(request)) });
    }
    if (request.method === "DELETE") {
      await deletePost(db, id);
      return jsonResponse({ ok: true });
    }
  }

  if (path === "/api/admin/pages") {
    if (request.method === "GET") {
      return jsonResponse({ pages: await listAdminPages(db) });
    }
    if (request.method === "POST") {
      return jsonResponse({ page: await createPage(db, await readJson(request)) }, { status: 201 });
    }
  }

  if (path.startsWith("/api/admin/pages/")) {
    const id = decodeURIComponent(path.slice("/api/admin/pages/".length));
    if (request.method === "PUT") {
      return jsonResponse({ page: await updatePage(db, id, await readJson(request)) });
    }
    if (request.method === "DELETE") {
      await deletePage(db, id);
      return jsonResponse({ ok: true });
    }
  }

  if (path === "/api/admin/categories") {
    if (request.method === "GET") {
      return jsonResponse({ categories: await listCategories(db) });
    }
    if (request.method === "POST") {
      return jsonResponse({ category: await createCategory(db, await readJson(request)) }, { status: 201 });
    }
  }

  if (path.startsWith("/api/admin/categories/")) {
    const id = decodeURIComponent(path.slice("/api/admin/categories/".length));
    if (request.method === "PUT") {
      return jsonResponse({ category: await updateCategory(db, id, await readJson(request)) });
    }
    if (request.method === "DELETE") {
      await deleteCategory(db, id);
      return jsonResponse({ ok: true });
    }
  }

  if (path === "/api/admin/media") {
    if (request.method === "GET") {
      return jsonResponse({ media: await listMediaAssets(db) });
    }
    if (request.method === "POST") {
      return await handleMediaUpload(request, env, db);
    }
  }

  return jsonResponse({ error: "Not found" }, { status: 404 });
}

async function handleMediaUpload(request, env, db) {
  if (!env.MEDIA_BUCKET) {
    return jsonResponse({ error: "Media bucket is not configured." }, { status: 503 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file.name !== "string" || typeof file.stream !== "function") {
    return jsonResponse({ error: "A file field is required." }, { status: 400 });
  }

  if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
    return jsonResponse({ error: "File is too large." }, { status: 413 });
  }

  const date = new Date();
  const ext = extensionFromFilename(file.name);
  const key = [
    "media",
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    `${crypto.randomUUID()}${ext}`,
  ].join("/");
  const contentType = file.type || "application/octet-stream";

  await env.MEDIA_BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType,
    },
  });

  const media = await createMediaAsset(db, {
    key,
    filename: file.name,
    contentType,
    size: file.size,
    alt: formData.get("alt") || "",
  });

  return jsonResponse({ media, url: `/media/${key}` }, { status: 201 });
}

async function handleMediaRequest(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  if (!env.MEDIA_BUCKET) {
    return new Response("Media bucket is not configured.", {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const key = decodeURIComponent(new URL(request.url).pathname.slice("/media/".length));
  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  headers.set("ETag", object.httpEtag || object.etag || "");
  headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function renderBlogIndexResponse(request, env) {
  if (!env.BLOG_DB) {
    return htmlResponse(renderBlogNotConfigured());
  }
  const posts = await listPublicPosts(env.BLOG_DB);
  return htmlResponse(renderBlogIndex(posts));
}

async function renderPostResponse(request, env, url) {
  if (!env.BLOG_DB) {
    return htmlResponse(renderBlogNotConfigured());
  }
  const slug = decodeURIComponent(trimSlashes(url.pathname.slice("/blog/".length)));
  const post = await getPublicPostBySlug(env.BLOG_DB, slug);
  return post
    ? htmlResponse(renderPost(post))
    : new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}

async function renderCategoryResponse(request, env, url) {
  if (!env.BLOG_DB) {
    return htmlResponse(renderBlogNotConfigured());
  }
  const slug = decodeURIComponent(trimSlashes(url.pathname.slice("/category/".length)));
  const category = await getCategoryBySlug(env.BLOG_DB, slug);
  if (!category) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const posts = await listPublicPostsByCategory(env.BLOG_DB, slug);
  return htmlResponse(renderCategory(category, posts));
}

async function renderPageResponse(request, env, url) {
  if (!env.BLOG_DB) {
    return htmlResponse(renderBlogNotConfigured());
  }
  const slug = decodeURIComponent(trimSlashes(url.pathname.slice("/p/".length)));
  const page = await getPublicPageBySlug(env.BLOG_DB, slug);
  return page
    ? htmlResponse(renderStandalonePage(page))
    : new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}

function acceptsHtml(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html") || accept.includes("*/*");
}

function withSiteHeaders(request, response) {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", cacheControlFor(url.pathname, headers.get("Content-Type")));
  }

  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function cacheControlFor(pathname, contentType) {
  if (IMMUTABLE_ASSET_PATH.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }

  if (pathname === "/favicon.svg" || pathname === "/favicon.ico") {
    return "public, max-age=86400";
  }

  if (pathname === "/robots.txt" || pathname === "/sitemap.xml") {
    return "public, max-age=3600, s-maxage=86400";
  }

  if (pathname.endsWith(".html") || contentType?.includes("text/html")) {
    return "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";
  }

  return "public, max-age=3600";
}

async function readAdminSession(request, env) {
  return await readSession({
    cookieHeader: request.headers.get("Cookie"),
    secret: env.SESSION_SECRET,
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new ServiceError("Request body must be valid JSON.", 400);
  }
}

function jsonResponse(body, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers,
  });
}

function htmlResponse(body, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, {
    status: options.status || 200,
    headers,
  });
}

function errorResponse(request, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status >= 500 ? "Internal Server Error" : error.message;
  if (new URL(request.url).pathname.startsWith("/api/")) {
    return jsonResponse({ error: message }, { status });
  }
  return new Response(message, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function trimTrailingSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function trimSlashes(path) {
  return path.replace(/^\/+|\/+$/g, "");
}

function extensionFromFilename(filename) {
  const match = String(filename).toLowerCase().match(/\.[a-z0-9]{1,12}$/);
  return match ? match[0] : "";
}

export { cacheControlFor, withSiteHeaders };
