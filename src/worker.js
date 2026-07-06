const IMMUTABLE_ASSET_PATH = /^\/(?:assets|vendor)\//;

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
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSiteHeaders(request, new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
        },
      }));
    }

    const url = new URL(request.url);
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
  },
};

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

  headers.set("Cache-Control", cacheControlFor(url.pathname, headers.get("Content-Type")));

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

export { cacheControlFor, withSiteHeaders };
