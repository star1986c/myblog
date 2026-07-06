# Cloudflare Personal Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the live `superstar1014.qzz.io` Worker Static Assets site as a maintainable repository, improve performance/security/SEO, deploy it to the existing Worker, and publish the code to GitHub.

**Architecture:** Keep Cloudflare Worker `wispy-cloud-0978` as the production target and configure Workers Static Assets in `wrangler.jsonc`. Serve static HTML/CSS/JS from `public/`, run the Worker first to add response headers and custom 404 handling, and vendor Three.js locally to remove the third-party module request.

**Tech Stack:** Cloudflare Workers, Workers Static Assets, Wrangler 4.x, plain HTML/CSS/ES modules, Three.js r160, Node.js built-in test runner.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `wrangler.jsonc`
- Create: `README.md`

- [x] Create npm scripts for tests, Wrangler validation, local dev, and deploy.
- [x] Configure `wrangler.jsonc` with Worker name `wispy-cloud-0978`, `assets.binding = "ASSETS"`, and `assets.run_worker_first = true`.
- [x] Document local and deploy commands.

### Task 2: Worker response layer

**Files:**
- Create: `src/worker.js`
- Create: `tests/headers.test.mjs`

- [x] Add security headers: CSP, HSTS, frame protection, referrer policy, permissions policy, content type sniffing protection.
- [x] Add cache policy for HTML, fingerprinted static assets, favicon, robots, and sitemap.
- [x] Add custom HTML 404 fallback when the visitor accepts HTML.
- [x] Test cache policy and security header behavior with `node --test`.

### Task 3: Static site assets

**Files:**
- Create: `public/index.html`
- Create: `public/404.html`
- Create: `public/favicon.svg`
- Create: `public/sitemap.xml`
- Create: `public/robots.txt`
- Create: `public/assets/styles.20260706.css`
- Create: `public/assets/solar-system.20260706.js`
- Create: `public/vendor/three-0.160.0.module.js`

- [x] Move inline CSS and JavaScript into fingerprinted assets.
- [x] Replace CDN import with same-origin Three.js vendor module.
- [x] Add canonical, Open Graph, Twitter, theme color, favicon, and sitemap metadata.
- [x] Preserve current visual identity while reducing WebGL cost: no preserved drawing buffer, lower pixel-ratio caps, smaller mobile star fields, visibility pause, and static reduced-motion rendering.

### Task 4: Validation and deployment

**Files:**
- Generated: `package-lock.json`
- Generated: `node_modules/`

- [ ] Install Wrangler.
- [ ] Run `npm test`.
- [ ] Run `npx wrangler check`.
- [ ] Run `npx wrangler deploy`.
- [ ] Verify live response headers and key files with `curl`.

### Task 5: GitHub publication

**Files:**
- Git-tracked project files.

- [ ] Commit the project.
- [ ] Create a GitHub repository for the project.
- [ ] Add `origin`.
- [ ] Push `main`.

GitHub creation currently depends on a valid `gh` login or an exposed repository-creation connector.
