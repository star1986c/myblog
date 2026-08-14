# AI Build Lab personal site

Cloudflare Workers Static Assets project for `https://superstar1014.qzz.io/`.

## What this project does

- Serves the existing solar-system WebGL landing page as static assets.
- Runs the Worker first so every response receives cache and security headers.
- Vendors Three.js locally to avoid a third-party CDN request on first load.
- Adds `favicon.svg`, `sitemap.xml`, and a robots file with AI crawler signals.
- Adds a standalone JSON formatter at `/json/`.
- Adds a standalone password generator at `/password/`; generation and copying stay in the browser
  and passwords are not stored automatically.
- Adds a single-login private notes workspace at `/notes/`; note titles and content are encrypted in
  the browser, while D1 stores only versioned AES-GCM envelopes.
- Stores the random notes data key in D1 only after wrapping it with a Worker secret, so forgetting
  or changing the login password no longer makes notes unreadable.
- Integrates login account settings into the notes workspace. The retired `/admin/` page redirects
  to `/notes/`; the password generator remains a separate public utility.
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
account, create encrypted note envelopes, and add the recoverable workspace keyring.

Default administrator:

- Username: `admin`
- Password: generated during setup; change it from `设置` inside the notes workspace.

`SESSION_SECRET` is required for administrator sessions. `NOTES_KEY_ENCRYPTION_SECRET`
wraps the random notes data key. Configure both as encrypted Worker secrets before deployment:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put NOTES_KEY_ENCRYPTION_SECRET
```

Losing `SESSION_SECRET` signs out existing sessions but does not affect encrypted notes.
Losing or rotating `NOTES_KEY_ENCRYPTION_SECRET` without first rewrapping the data key makes existing
notes unrecoverable. Keep that secret backed up through the Cloudflare account's secure secret workflow.
Private notes encrypt the full `{ title, content }` payload in the browser and use a unique AES-GCM
nonce plus record-bound authenticated data for every save.

Migration `0005_make_blog_private.sql` revokes any previous article/page publication flags and adds
the ciphertext-only `encrypted_notes` table. Migration `0006_delete_legacy_blog_content.sql` then
permanently deletes legacy posts, pages, categories, post-category links, and media records. It does
not delete administrator accounts or encrypted notes. Migration `0007_recoverable_notes_key.sql`
replaces the forgotten master-password key relationship with `workspace_keyrings` and removes the
retired password-vault tables. Apply it only after confirming those legacy encrypted tables are empty.

R2 is not required for the private notes workspace or production deployment.

## macOS notes app

The native SwiftUI client lives in `macos/AIBuildNotes`. It reuses the existing login, workspace key,
and ciphertext-only notes API. Search happens locally after decryption. Migration
`0008_note_trash_and_revisions.sql` adds optimistic revisions and a recoverable trash state for app
clients while keeping the existing web API compatible.

Migration `0010_note_protection.sql` adds an explicit server-side lock flag and one wrapped global
protection key. The independent protection password never leaves the client: PBKDF2-HMAC-SHA256
derives a wrapping key, while a random AES-256-GCM key encrypts protected note bodies a second time.
macOS and Web share the format, show locked notes without exposing the body, and require the same
independent protection password to reveal any protected note.

Run its focused tests and build an ad-hoc signed app bundle:

```bash
swift test --package-path macos/AIBuildNotes
/bin/zsh scripts/build-macos-app.sh
```

The bundle is written to `output/AI Build Notes.app`.
The 1024px icon master is stored at `macos/AIBuildNotes/Assets/AppIcon-1024.png`; the build script
generates and embeds the complete `.icns` representation.

## Deploy

```bash
npm run deploy
```

The deployment target is configured in `wrangler.jsonc`. The custom domain already points to Worker `wispy-cloud-0978`.

## Cache policy

- Public HTML: `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`
- `/notes/`, retired private redirects, and all APIs: `no-store`
- Fingerprinted static assets under `/assets/` and `/vendor/`: `public, max-age=31536000, immutable`
- SEO metadata files: short browser cache, longer edge cache

When changing CSS or JavaScript, create a new fingerprinted filename and update `public/index.html`.
