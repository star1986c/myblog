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
- Provides a ciphertext-only notes backend for the native macOS and Android clients; there is no Web
  notes page or public notes entry.
- Stores the random notes data key in D1 only after wrapping it with a Worker secret, so forgetting
  or changing the login password no longer makes notes unreadable.
- Keeps the retired `/admin/` and former blog/article/page routes out of the notes product; they
  redirect to the public home page. The password generator remains a separate public utility.
- Removes all legacy blog content from public APIs and the sitemap.
- Keeps the Worker name as `wispy-cloud-0978`, matching the current Cloudflare custom domain binding.

## Local commands

```bash
npm install
npm test
npm run check
npm run dev
```

`npm run dev` starts Wrangler on `http://localhost:8787`.

## Native notes backend setup

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
- Password: generated during setup; change it through the authenticated account API when required.

`SESSION_SECRET` is required for administrator sessions. `NOTES_KEY_ENCRYPTION_SECRET`
wraps the random notes data key. Configure both as encrypted Worker secrets before deployment:

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put NOTES_KEY_ENCRYPTION_SECRET
```

Losing `SESSION_SECRET` signs out existing sessions but does not affect encrypted notes.
Losing or rotating `NOTES_KEY_ENCRYPTION_SECRET` without first rewrapping the data key makes existing
notes unrecoverable. Keep that secret backed up through the Cloudflare account's secure secret workflow.
The native clients encrypt the full `{ title, content }` payload before upload and use a unique
AES-GCM nonce plus record-bound authenticated data for every save.

Migration `0005_make_blog_private.sql` revokes any previous article/page publication flags and adds
the ciphertext-only `encrypted_notes` table. Migration `0006_delete_legacy_blog_content.sql` then
permanently deletes legacy posts, pages, categories, post-category links, and media records. It does
not delete administrator accounts or encrypted notes. Migration `0007_recoverable_notes_key.sql`
replaces the forgotten master-password key relationship with `workspace_keyrings` and removes the
retired password-vault tables. Apply it only after confirming those legacy encrypted tables are empty.

Migration `0011_encrypted_folder_order.sql` stores the manual folder order shared by both clients.

R2 is not required for the native notes backend or production deployment.

## macOS notes app

The native SwiftUI client lives in `macos/AIBuildNotes`. It reuses the existing login, workspace key,
and ciphertext-only notes API. Search happens locally after decryption. Migration
`0008_note_trash_and_revisions.sql` adds optimistic revisions and a recoverable trash state for app
clients while keeping the authenticated ciphertext API compatible.

Migration `0010_note_protection.sql` adds an explicit server-side lock flag and one wrapped global
protection key. The independent protection password never leaves the client: PBKDF2-HMAC-SHA256
derives a wrapping key, while a random AES-256-GCM key encrypts protected note bodies a second time.
macOS and Android share the format, show locked notes without exposing the body, and require the same
independent protection password to reveal any protected note.

Run its focused tests and build an ad-hoc signed app bundle:

```bash
swift test --package-path macos/AIBuildNotes
/bin/zsh scripts/build-macos-app.sh
```

The bundle is written to `output/My Notes.app`.
The 1024px icon master is stored at `macos/AIBuildNotes/Assets/AppIcon-1024.png`; the build script
generates and embeds the complete `.icns` representation.

## Android notes app

The native Android client lives in `android/MyNotes`. It uses the same authenticated Worker API,
AES-256-GCM envelopes, folders, recoverable trash, and shared independent protection password as
the macOS client. The user-visible product name is `My Notes`; historical cryptographic
additional-data identifiers remain unchanged for ciphertext compatibility.

The mobile UI is designed specifically for Android 16 (API 36) with edge-to-edge system bars,
light/dark themes, visible folder filters, adaptive list/card layouts, and a consistent vector icon
set. Older Android releases are intentionally unsupported.

Build an installable debug APK with the checked-in wrapper:

```bash
cd android/MyNotes
./gradlew assembleDebug
```

The APK is written to `android/MyNotes/app/build/outputs/apk/debug/app-debug.apk`.

## Deploy

```bash
npm run deploy
```

The deployment target is configured in `wrangler.jsonc`. The custom domain already points to Worker `wispy-cloud-0978`.

## Cache policy

- Public HTML: `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`
- Removed `/notes` paths, retired admin redirects, and all APIs: `no-store`
- Fingerprinted static assets under `/assets/` and `/vendor/`: `public, max-age=31536000, immutable`
- SEO metadata files: short browser cache, longer edge cache

When changing CSS or JavaScript, create a new fingerprinted filename and update `public/index.html`.
