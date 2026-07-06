# AI Build Lab personal site

Cloudflare Workers Static Assets project for `https://superstar1014.qzz.io/`.

## What this project does

- Serves the existing solar-system WebGL landing page as static assets.
- Runs the Worker first so every response receives cache and security headers.
- Vendors Three.js locally to avoid a third-party CDN request on first load.
- Adds `favicon.svg`, `sitemap.xml`, and a robots file with AI crawler signals.
- Keeps the Worker name as `wispy-cloud-0978`, matching the current Cloudflare custom domain binding.

## Local commands

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run dev` starts Wrangler on `http://localhost:8787`.

## Deploy

```bash
npm run deploy
```

The deployment target is configured in `wrangler.jsonc`. The custom domain already points to Worker `wispy-cloud-0978`.

## Cache policy

- HTML: `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`
- Fingerprinted static assets under `/assets/` and `/vendor/`: `public, max-age=31536000, immutable`
- SEO metadata files: short browser cache, longer edge cache

When changing CSS or JavaScript, create a new fingerprinted filename and update `public/index.html`.
