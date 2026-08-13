# AI Build Lab personal site

Cloudflare Workers Static Assets project for `https://superstar1014.qzz.io/`.

## What this project does

- Serves the existing solar-system WebGL landing page as static assets.
- Runs the Worker first so every response receives cache and security headers.
- Vendors Three.js locally to avoid a third-party CDN request on first load.
- Adds `favicon.svg`, `sitemap.xml`, and a robots file with AI crawler signals.
- Adds a standalone JSON formatter at `/json/`.
- Adds a standalone secure password generator at `/password/` without browser password persistence.
- Adds a private zero-knowledge password vault inside `/admin/`; the master password and plaintext
  entries stay in browser memory while D1 stores only versioned AES-GCM ciphertext.
- Adds an encrypted private notes workspace at `/notes/`; note titles and content are encrypted in
  the browser with the password-vault data key, while D1 stores only AES-GCM envelopes.
- Redirects former public blog/article/page routes to the private notes workspace and removes all
  blog content from public APIs and the sitemap.
- Keeps the Worker name as `wispy-cloud-0978`, matching the current Cloudflare custom domain binding.

## Local commands

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run dev` starts Wrangler on `http://localhost:8787`.

## Private notes backend setup

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
account, encrypted password-vault storage, and encrypted note envelopes.

Default administrator:

- Username: `admin`
- Password: generated during setup; change it immediately from the `Account` tab.

`SESSION_SECRET` is required for administrator sessions and must be configured as
an encrypted Worker secret before deployment:

```bash
npx wrangler secret put SESSION_SECRET
```

The password-vault migration removes the legacy D1 session-secret fallback. Losing
`SESSION_SECRET` signs out existing sessions but does not affect encrypted vault data.
The separate vault master password is never stored by the Worker and cannot be recovered. Private
notes reuse the vault's random data key, encrypt the full `{ title, content }` payload in the browser,
and use a unique AES-GCM nonce plus record-bound authenticated data for every save.

Migration `0005_make_blog_private.sql` revokes any previous article/page publication flags and adds
the ciphertext-only `encrypted_notes` table. Existing blog rows are retained as private drafts but
are not automatically converted because the Worker never receives the vault master password.

Media records use manually entered URLs, so R2 is not required for the blog
admin or production deployment.

## Deploy

```bash
npm run deploy
```

The deployment target is configured in `wrangler.jsonc`. The custom domain already points to Worker `wispy-cloud-0978`.

## Cache policy

- Public HTML: `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`
- `/notes/` and `/admin/` HTML shells plus all APIs: `no-store`
- Fingerprinted static assets under `/assets/` and `/vendor/`: `public, max-age=31536000, immutable`
- SEO metadata files: short browser cache, longer edge cache

When changing CSS or JavaScript, create a new fingerprinted filename and update `public/index.html`.
