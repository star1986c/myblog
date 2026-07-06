# AI Build Lab personal site

Cloudflare Workers Static Assets project for `https://superstar1014.qzz.io/`.

## What this project does

- Serves the existing solar-system WebGL landing page as static assets.
- Runs the Worker first so every response receives cache and security headers.
- Vendors Three.js locally to avoid a third-party CDN request on first load.
- Adds `favicon.svg`, `sitemap.xml`, and a robots file with AI crawler signals.
- Adds a standalone JSON formatter at `/json/`.
- Adds a standalone blog admin console at `/admin/`, public blog pages under `/blog/`,
  D1-backed content storage, and manually entered media URL records.
- Keeps the Worker name as `wispy-cloud-0978`, matching the current Cloudflare custom domain binding.

## Local commands

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run dev` starts Wrangler on `http://localhost:8787`.

## Blog backend setup

Create the Cloudflare D1 database before production deployment:

```bash
npx wrangler d1 create superstar1014-blog
```

The current D1 database ID is already written in `wrangler.jsonc`. After
creating or changing the D1 database, run:

```bash
npx wrangler d1 migrations apply superstar1014-blog --remote
```

Apply migrations before deployment. The migrations seed a D1-backed administrator
account so the site can be tested without R2 or credential secrets.

Default administrator:

- Username: `admin`
- Password: generated during setup; change it immediately from the `账号` tab.

`SESSION_SECRET` can still be set as an encrypted Worker secret to override the
D1-seeded session secret:

```bash
npx wrangler secret put SESSION_SECRET
```

New articles and pages default to `draft` and `private`. A public page only shows
content where `status = published` and `visibility = public`.

Media records use manually entered URLs, so R2 is not required for the blog
admin or production deployment.

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
