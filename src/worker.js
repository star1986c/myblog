import {
  clearSessionCookie,
  createPasswordHash,
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
  getAdminAccount,
  getAdminSetting,
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
  updateAdminAccount,
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
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const IP_PROVIDER_TIMEOUT_MS = 2200;
const IP_CACHE_TTL_SECONDS = 6 * 60 * 60;
const VISITOR_NETWORK_HEADER = "X-AI-Build-Lab-Request";
const VISITOR_NETWORK_HEADER_VALUE = "visitor-network";
const CACHEABLE_NETWORK_SOURCES = ["ipinfo", "ipwhois", "geojs"];

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https: http:",
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
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return withSiteHeaders(request, errorResponse(request, error));
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) {
    return withSiteHeaders(request, await handleApiRequest(request, env, ctx));
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

async function handleApiRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = trimTrailingSlash(url.pathname);

  if (path === "/api/auth/me" && request.method === "GET") {
    const session = await readAdminSession(request, env);
    const account = session && env.BLOG_DB ? await getAdminAccount(env.BLOG_DB) : null;
    return jsonResponse({
      authenticated: Boolean(session),
      user: session ? publicAdminAccount(account, session.username) : null,
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

  if (path === "/api/public/ip-info" && request.method === "GET") {
    const allowed = await allowVisitorNetworkRequest(request, env);
    if (!allowed) {
      return jsonResponse(
        { error: "查询过于频繁，请稍后重试。" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    }
    return jsonResponse(await lookupVisitorNetworkInfo(request, env, { ctx }));
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

async function allowVisitorNetworkRequest(request, env) {
  const url = new URL(request.url);
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const isSameOriginFetch = !fetchSite || fetchSite === "same-origin";
  const hasExpectedHeader =
    request.headers.get(VISITOR_NETWORK_HEADER) === VISITOR_NETWORK_HEADER_VALUE;
  const acceptsJson = (request.headers.get("Accept") || "").includes("application/json");

  if (!hasExpectedHeader || !acceptsJson || !isSameOriginFetch || url.search) {
    throw new ServiceError("Forbidden.", 403);
  }

  const ip = visitorClientIp(request);
  if (!ip) {
    throw new ServiceError("Client IP is unavailable.", 503);
  }

  const clientLimiter = env.IP_INFO_CLIENT_RATE_LIMITER;
  const ipLimiter = env.IP_INFO_IP_RATE_LIMITER;
  if (typeof clientLimiter?.limit !== "function" || typeof ipLimiter?.limit !== "function") {
    throw new ServiceError("Visitor network protection is unavailable.", 503);
  }

  const ipDigest = await sha256Hex(ip);
  const userAgent = safeNetworkText(request.headers.get("User-Agent")) || "unknown";
  const clientDigest = await sha256Hex(`${ipDigest}\n${userAgent}`);
  const [clientLimit, ipLimit] = await Promise.all([
    clientLimiter.limit({ key: `visitor-network:client:${clientDigest}` }),
    ipLimiter.limit({ key: `visitor-network:ip:${ipDigest}` }),
  ]);
  return clientLimit.success && ipLimit.success;
}

async function lookupVisitorNetworkInfo(request, env = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const cache = dependencies.cache === undefined ? defaultVisitorCache() : dependencies.cache;
  const ip = visitorClientIp(request);
  if (!ip) {
    throw new ServiceError("Client IP is unavailable.", 503);
  }

  const fallback = cloudflareNetworkInfo(request, ip);
  if (!isPublicRoutableIp(ip)) {
    return unattributedNetworkInfo(ip);
  }

  const cacheKey = cache ? await visitorNetworkCacheKey(request, ip) : null;
  if (cache && cacheKey) {
    const cached = await readVisitorNetworkCache(cache, cacheKey, ip);
    if (cached) {
      return cached;
    }
  }

  const providers = visitorNetworkProviders(ip, env);
  for (const provider of providers) {
    const network = await queryVisitorNetworkProvider(provider, fetchImpl, fallback);
    if (network) {
      if (cache && cacheKey) {
        await storeVisitorNetworkCache(cache, cacheKey, network, dependencies.ctx);
      }
      return network;
    }
  }

  return fallback;
}

function visitorClientIp(request) {
  return (
    normalizeClientIp(request.headers.get("CF-Connecting-IPv6")) ||
    normalizeClientIp(request.headers.get("CF-Connecting-IP"))
  );
}

function defaultVisitorCache() {
  return typeof caches === "undefined" ? null : caches.default;
}

async function visitorNetworkCacheKey(request, ip) {
  const digest = await sha256Hex(ip);
  return new Request(
    new URL(`/__internal/visitor-network-cache/v2/${digest}`, request.url),
    { method: "GET" },
  );
}

async function readVisitorNetworkCache(cache, cacheKey, ip) {
  try {
    const response = await cache.match(cacheKey);
    if (!response) {
      return null;
    }

    const body = await response.json();
    const source = safeNetworkText(body?.source);
    if (!body || typeof body !== "object" || !CACHEABLE_NETWORK_SOURCES.includes(source)) {
      return null;
    }

    const network = {
      ip,
      city: safeNetworkText(body.city),
      region: safeNetworkText(body.region),
      country: safeNetworkText(body.country),
      countryCode: safeNetworkText(body.countryCode),
      asn: normalizeAsn(body.asn),
      organization: safeNetworkText(body.organization),
      source,
      cached: true,
    };
    return hasNetworkAttribution(network) ? network : null;
  } catch (error) {
    logVisitorNetworkWarning("ip_cache_read_failed", { message: errorMessage(error) });
    return null;
  }
}

async function storeVisitorNetworkCache(cache, cacheKey, network, ctx) {
  const body = {
    city: network.city,
    region: network.region,
    country: network.country,
    countryCode: network.countryCode,
    asn: network.asn,
    organization: network.organization,
    source: network.source,
  };
  const response = new Response(JSON.stringify(body), {
    headers: {
      "Cache-Control": `public, max-age=${IP_CACHE_TTL_SECONDS}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
  const write = cache.put(cacheKey, response).catch((error) => {
    logVisitorNetworkWarning("ip_cache_write_failed", { message: errorMessage(error) });
  });

  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(write);
  } else {
    await write;
  }
}

function visitorNetworkProviders(ip, env) {
  const encodedIp = encodeURIComponent(ip);
  const ipinfoHeaders = new Headers({ Accept: "application/json" });
  let ipinfoEndpoint = `https://ipinfo.io/${encodedIp}/json`;

  if (typeof env.IPINFO_TOKEN === "string" && env.IPINFO_TOKEN.trim()) {
    ipinfoEndpoint = `https://api.ipinfo.io/lite/${encodedIp}`;
    ipinfoHeaders.set("Authorization", `Bearer ${env.IPINFO_TOKEN.trim()}`);
  }

  return [
    {
      name: "ipinfo",
      endpoint: ipinfoEndpoint,
      headers: ipinfoHeaders,
      accepts: hasIpinfoAttribution,
      normalize: mergeIpinfoNetworkInfo,
    },
    {
      name: "ipwhois",
      endpoint:
        `https://ipwho.is/${encodedIp}` +
        "?fields=success,country,country_code,region,city,connection",
      headers: new Headers({ Accept: "application/json" }),
      accepts: hasIpwhoisAttribution,
      normalize: mergeIpwhoisNetworkInfo,
    },
    {
      name: "geojs",
      endpoint: `https://get.geojs.io/v1/ip/geo/${encodedIp}.json`,
      headers: new Headers({ Accept: "application/json" }),
      accepts: hasGeoJsAttribution,
      normalize: mergeGeoJsNetworkInfo,
    },
  ];
}

async function queryVisitorNetworkProvider(provider, fetchImpl, fallback) {
  try {
    const response = await fetchImpl(provider.endpoint, {
      method: "GET",
      headers: provider.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(IP_PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`${provider.name} returned ${response.status}.`);
    }

    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || !provider.accepts(body)) {
      throw new Error(`${provider.name} returned no usable attribution.`);
    }

    return provider.normalize(body, fallback);
  } catch (error) {
    logVisitorNetworkWarning("ip_provider_failed", {
      provider: provider.name,
      message: errorMessage(error),
    });
    return null;
  }
}

function hasIpinfoAttribution(body) {
  const nestedAsn = body.asn && typeof body.asn === "object" ? body.asn : {};
  return !body.error && [
    body.city,
    body.region,
    body.country,
    body.country_code,
    body.org,
    body.as_name,
    typeof body.asn === "string" ? body.asn : nestedAsn.asn,
  ].some(Boolean);
}

function hasIpwhoisAttribution(body) {
  const connection = body.connection && typeof body.connection === "object" ? body.connection : {};
  return body.success !== false && [
    body.city,
    body.region,
    body.country,
    body.country_code,
    connection.asn,
    connection.org,
    connection.isp,
  ].some(Boolean);
}

function hasGeoJsAttribution(body) {
  return !body.error && [
    body.city,
    body.region,
    body.country,
    body.country_code,
    body.asn,
    body.organization_name,
    body.organization,
  ].some(Boolean);
}

function normalizeClientIp(value) {
  const ip = typeof value === "string" ? value.trim() : "";
  if (!ip || ip.length > 45) {
    return "";
  }

  const ipv4Parts = ip.split(".");
  const isIpv4 = ipv4Parts.length === 4 && ipv4Parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const number = Number(part);
    return number >= 0 && number <= 255;
  });
  const isIpv6 = ip.includes(":") && /^[0-9a-f:.]+$/i.test(ip);
  return isIpv4 || isIpv6 ? ip : "";
}

function isPublicRoutableIp(ip) {
  const ipv4 = parseIpv4(ip);
  if (ipv4) {
    return isPublicRoutableIpv4(ipv4);
  }

  const normalized = ip.toLowerCase();
  const mappedIpv4 = normalized.startsWith("::ffff:")
    ? parseIpv4(normalized.slice("::ffff:".length))
    : null;
  if (mappedIpv4) {
    return isPublicRoutableIpv4(mappedIpv4);
  }

  return normalized !== "::" &&
    normalized !== "::1" &&
    !normalized.startsWith("fc") &&
    !normalized.startsWith("fd") &&
    !/^fe[89ab]/.test(normalized) &&
    !normalized.startsWith("ff") &&
    !normalized.startsWith("2001:db8:");
}

function parseIpv4(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function isPublicRoutableIpv4([first, second]) {
  return first !== 0 &&
    first !== 10 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    first !== 127 &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 0) &&
    !(first === 192 && second === 168) &&
    !(first === 198 && (second === 18 || second === 19)) &&
    !(first === 198 && second === 51) &&
    !(first === 203 && second === 0) &&
    first < 224;
}

function cloudflareNetworkInfo(request, ip) {
  const cf = request.cf && typeof request.cf === "object" ? request.cf : {};
  const asn = Number.isInteger(cf.asn) ? `AS${cf.asn}` : "";
  return {
    ip,
    city: safeNetworkText(cf.city),
    region: safeNetworkText(cf.region),
    country: safeNetworkText(cf.country),
    countryCode: safeNetworkText(cf.country),
    asn,
    organization: safeNetworkText(cf.asOrganization),
    source: "cloudflare",
    cached: false,
  };
}

function unattributedNetworkInfo(ip) {
  return {
    ip,
    city: "",
    region: "",
    country: "",
    countryCode: "",
    asn: "",
    organization: "",
    source: "cloudflare",
    cached: false,
  };
}

function mergeIpinfoNetworkInfo(body, fallback) {
  const legacyOrganization = parseLegacyOrganization(body.org);
  const nestedAsn = body.asn && typeof body.asn === "object" ? body.asn : {};
  const rawCountry = safeNetworkText(body.country);
  const explicitCountryCode = safeNetworkText(body.country_code);
  const countryCode = explicitCountryCode || (/^[A-Z]{2}$/.test(rawCountry) ? rawCountry : "");
  const directAsn = typeof body.asn === "string" ? safeNetworkText(body.asn) : "";

  return {
    ip: fallback.ip,
    city: safeNetworkText(body.city) || fallback.city,
    region: safeNetworkText(body.region) || fallback.region,
    country: rawCountry || fallback.country,
    countryCode: countryCode || fallback.countryCode,
    asn: directAsn || safeNetworkText(nestedAsn.asn) || legacyOrganization.asn || fallback.asn,
    organization:
      safeNetworkText(body.as_name) ||
      safeNetworkText(nestedAsn.name) ||
      legacyOrganization.organization ||
      fallback.organization,
    source: "ipinfo",
    cached: false,
  };
}

function mergeIpwhoisNetworkInfo(body, fallback) {
  const connection = body.connection && typeof body.connection === "object" ? body.connection : {};
  return {
    ip: fallback.ip,
    city: safeNetworkText(body.city) || fallback.city,
    region: safeNetworkText(body.region) || fallback.region,
    country: safeNetworkText(body.country) || fallback.country,
    countryCode: safeNetworkText(body.country_code) || fallback.countryCode,
    asn: normalizeAsn(connection.asn) || fallback.asn,
    organization:
      safeNetworkText(connection.org) ||
      safeNetworkText(connection.isp) ||
      fallback.organization,
    source: "ipwhois",
    cached: false,
  };
}

function mergeGeoJsNetworkInfo(body, fallback) {
  const legacyOrganization = parseLegacyOrganization(body.organization);
  return {
    ip: fallback.ip,
    city: safeNetworkText(body.city) || fallback.city,
    region: safeNetworkText(body.region) || fallback.region,
    country: safeNetworkText(body.country) || fallback.country,
    countryCode: safeNetworkText(body.country_code) || fallback.countryCode,
    asn: normalizeAsn(body.asn) || legacyOrganization.asn || fallback.asn,
    organization:
      safeNetworkText(body.organization_name) ||
      legacyOrganization.organization ||
      fallback.organization,
    source: "geojs",
    cached: false,
  };
}

function parseLegacyOrganization(value) {
  const organization = safeNetworkText(value);
  const match = /^(AS\d+)\s+(.+)$/.exec(organization);
  return match
    ? { asn: match[1], organization: match[2] }
    : { asn: "", organization };
}

function safeNetworkText(value) {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function normalizeAsn(value) {
  if (Number.isInteger(value) && value > 0) {
    return `AS${value}`;
  }
  const asn = safeNetworkText(value).toUpperCase();
  if (/^AS\d+$/.test(asn)) {
    return asn;
  }
  return /^\d+$/.test(asn) ? `AS${asn}` : "";
}

function hasNetworkAttribution(network) {
  return [
    network.city,
    network.region,
    network.country,
    network.countryCode,
    network.asn,
    network.organization,
  ].some(Boolean);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function logVisitorNetworkWarning(event, details) {
  console.warn(JSON.stringify({ level: "warn", event, ...details }));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown visitor network error";
}

async function handleLogin(request, env) {
  const db = requireDatabase(env);
  const account = await getAdminAccount(db);
  const credentials = account || legacyAdminAccount(env);
  const sessionSecret = await resolveSessionSecret(env, db);

  if (!credentials || !sessionSecret) {
    return jsonResponse({ error: "Authentication is not configured." }, { status: 503 });
  }

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const passwordMatches = await verifyPasswordHash(password, credentials.passwordHash);

  if (username !== credentials.username || !passwordMatches) {
    return jsonResponse({ error: "Invalid username or password." }, { status: 401 });
  }

  const cookie = await signSession({
    secret: sessionSecret,
    username: credentials.username,
  });
  const session = await readSession({
    cookieHeader: cookie,
    secret: sessionSecret,
  });

  return jsonResponse(
    {
      ok: true,
      user: publicAdminAccount(credentials),
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

  if (path === "/api/admin/account") {
    if (request.method === "GET") {
      const account = await getAdminAccount(db);
      return jsonResponse({ account: publicAdminAccount(account, session.username) });
    }
    if (request.method === "PUT") {
      return await handleAccountUpdate(request, env, db);
    }
  }

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
      return jsonResponse({ media: await createMediaAsset(db, await readJson(request)) }, { status: 201 });
    }
  }

  return jsonResponse({ error: "Not found" }, { status: 404 });
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

  if (isDynamicContentPath(pathname)) {
    return "public, max-age=60, s-maxage=60";
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

function isDynamicContentPath(pathname) {
  return (
    pathname === "/blog" ||
    pathname === "/blog/" ||
    pathname.startsWith("/blog/") ||
    pathname.startsWith("/category/") ||
    pathname.startsWith("/p/")
  );
}

async function readAdminSession(request, env) {
  const sessionSecret = await resolveSessionSecret(env, env.BLOG_DB);
  return await readSession({
    cookieHeader: request.headers.get("Cookie"),
    secret: sessionSecret,
  });
}

async function resolveSessionSecret(env, db) {
  if (env.SESSION_SECRET) {
    return env.SESSION_SECRET;
  }
  return db ? await getAdminSetting(db, "session_secret") : "";
}

function legacyAdminAccount(env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH) {
    return null;
  }
  return {
    id: "legacy",
    username: env.ADMIN_USERNAME,
    passwordHash: env.ADMIN_PASSWORD_HASH,
    mustChangePassword: 0,
  };
}

async function handleAccountUpdate(request, env, db) {
  const account = await getAdminAccount(db);
  if (!account) {
    throw new ServiceError("Administrator account is not configured.", 503);
  }

  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!username) {
    throw new ServiceError("Username is required.", 400);
  }
  if (newPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new ServiceError(`New password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`, 400);
  }
  if (!(await verifyPasswordHash(currentPassword, account.passwordHash))) {
    throw new ServiceError("Current password is incorrect.", 403);
  }

  const updated = await updateAdminAccount(db, account.id, {
    username,
    passwordHash: await createPasswordHash(newPassword),
    mustChangePassword: 0,
  });
  const sessionSecret = await resolveSessionSecret(env, db);
  const cookie = await signSession({
    secret: sessionSecret,
    username: updated.username,
  });
  const session = await readSession({
    cookieHeader: cookie,
    secret: sessionSecret,
  });

  return jsonResponse(
    {
      account: publicAdminAccount(updated),
      csrfToken: session.csrfToken,
    },
    {
      headers: {
        "Set-Cookie": cookie,
      },
    },
  );
}

function publicAdminAccount(account, fallbackUsername = "") {
  return {
    username: account?.username || fallbackUsername,
    mustChangePassword: Boolean(Number(account?.mustChangePassword || 0)),
  };
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
  if (status >= 500) {
    console.error(JSON.stringify({
      level: "error",
      path: new URL(request.url).pathname,
      message: error?.message || "Unknown error",
      stack: error?.stack || "",
    }));
  }
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

export { cacheControlFor, lookupVisitorNetworkInfo, withSiteHeaders };
