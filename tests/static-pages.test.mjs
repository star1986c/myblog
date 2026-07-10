import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const jsonHtml = await readFile(new URL("../public/json/index.html", import.meta.url), "utf8");
const passwordHtml = await readFile(new URL("../public/password/index.html", import.meta.url), "utf8");
const passwordJs = await readFile(
  new URL("../public/assets/password-tool.20260710.js", import.meta.url),
  "utf8",
);
const adminHtml = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
const adminCss = await readFile(new URL("../public/assets/admin.20260707.css", import.meta.url), "utf8");
const adminJs = await readFile(new URL("../public/assets/admin.20260707.js", import.meta.url), "utf8");
const sitemapXml = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

test("home page links to the JSON tool without embedding the formatter", () => {
  assert.match(indexHtml, /href="\/json\/"/);
  assert.doesNotMatch(indexHtml, /data-json-tool/);
  assert.doesNotMatch(indexHtml, /json-tool\.20260706\.js/);
  assert.doesNotMatch(indexHtml, /styles\.20260706-json\.css/);
});

test("home page links to the standalone password generator", () => {
  assert.match(indexHtml, /href="\/password\/"/);
  assert.doesNotMatch(indexHtml, /data-password-tool/);
});

test("home page presents the site as personal developer tools and a technical blog", () => {
  assert.match(indexHtml, /个人开发工具与技术博客/);
  assert.match(indexHtml, /Personal developer lab/);
  assert.match(indexHtml, /href="\/blog\/"/);
  assert.match(indexHtml, /id="tools"/);
  assert.match(indexHtml, /id="about"/);
  assert.match(indexHtml, /href="\/assets\/styles\.20260710\.css"/);
});

test("JSON formatter is served from a standalone page", () => {
  assert.match(jsonHtml, /<main class="tool-shell" data-json-tool>/);
  assert.match(jsonHtml, /href="https:\/\/superstar1014\.qzz\.io\/json\/"/);
  assert.match(jsonHtml, /href="\/assets\/json-page\.20260710\.css"/);
  assert.match(jsonHtml, /href="\/assets\/tool-brand\.20260710\.css"/);
  assert.match(jsonHtml, /src="\/assets\/json-tool\.20260706\.js"/);
});

test("standalone JSON page includes a tree viewer toolbar and property table", () => {
  assert.match(jsonHtml, /data-json-search/);
  assert.match(jsonHtml, /data-json-action="next"/);
  assert.match(jsonHtml, /data-json-action="previous"/);
  assert.match(jsonHtml, /data-json-action="expand"/);
  assert.match(jsonHtml, /data-json-action="collapse"/);
  assert.match(jsonHtml, /data-json-properties/);
  assert.match(jsonHtml, /<th>Name<\/th>/);
  assert.match(jsonHtml, /<th>Value<\/th>/);
});

test("standalone JSON page includes a right click context menu for selected tree nodes", () => {
  assert.match(jsonHtml, /data-json-context-menu/);
  assert.match(jsonHtml, /data-json-menu-action="copy-key"/);
  assert.match(jsonHtml, /data-json-menu-action="copy-value"/);
  assert.match(jsonHtml, /data-json-menu-action="copy-pair"/);
  assert.match(jsonHtml, /data-json-menu-action="expand-children"/);
  assert.match(jsonHtml, /data-json-menu-action="expand-all"/);
  assert.match(jsonHtml, /data-json-menu-action="collapse-children"/);
  assert.match(jsonHtml, /data-json-menu-action="collapse-all"/);
});

test("sitemap includes the standalone JSON tool URL", () => {
  assert.match(sitemapXml, /<loc>https:\/\/superstar1014\.qzz\.io\/json\/<\/loc>/);
});

test("password generator includes secure local controls and history", () => {
  assert.match(passwordHtml, /<main class="password-shell" data-password-tool>/);
  assert.match(passwordHtml, /href="https:\/\/superstar1014\.qzz\.io\/password\/"/);
  assert.match(passwordHtml, /href="\/assets\/tool-brand\.20260710\.css"/);
  assert.match(passwordHtml, /data-character="lowercase"/);
  assert.match(passwordHtml, /data-character="symbols"/);
  assert.match(passwordHtml, /data-password-excluded/);
  assert.match(passwordHtml, /data-password-length/);
  assert.match(passwordHtml, /data-password-count/);
  assert.match(passwordHtml, /data-password-history-enabled/);
  assert.match(passwordHtml, /data-password-history/);
  assert.match(passwordHtml, /src="\/assets\/password-tool\.20260710\.js"/);
  assert.match(passwordJs, /generatePasswords/);
  assert.match(passwordJs, /localStorage/);
});

test("sitemap includes the standalone password generator URL", () => {
  assert.match(sitemapXml, /<loc>https:\/\/superstar1014\.qzz\.io\/password\/<\/loc>/);
});

test("admin console is served from a standalone page with private article defaults", () => {
  assert.match(adminHtml, /data-admin-app/);
  assert.match(adminHtml, /href="\/assets\/admin\.20260707\.css"/);
  assert.match(adminHtml, /src="\/assets\/admin\.20260707\.js"/);
  assert.match(adminHtml, /name="visibility"/);
  assert.match(adminHtml, /value="private" selected/);
  assert.match(adminHtml, /name="status"/);
  assert.match(adminHtml, /value="draft" selected/);
});

test("admin console uses manual media URLs instead of file upload", () => {
  assert.match(adminHtml, /data-tab="media"/);
  assert.match(adminHtml, /data-media-form/);
  assert.match(adminHtml, /name="url"/);
  assert.doesNotMatch(adminHtml, /type="file"/);
});

test("admin console includes an account password change panel", () => {
  assert.match(adminHtml, /data-tab="account"/);
  assert.match(adminHtml, /data-account-form/);
  assert.match(adminHtml, /name="currentPassword"/);
  assert.match(adminHtml, /name="newPassword"/);
});

test("admin console presents a polished content workspace", () => {
  assert.match(adminHtml, /Content Studio/);
  assert.match(adminHtml, /data-section-description/);
  assert.match(adminHtml, /data-workspace-message/);
  assert.match(adminHtml, /data-create-label="新建文章"/);
  assert.match(adminHtml, /class="form-section"/);
  assert.match(adminHtml, /class="list-column"/);
  assert.match(adminCss, /\.workspace-shell/);
  assert.match(adminCss, /\.status-badge/);
  assert.match(adminCss, /\.empty-state/);
  assert.match(adminJs, /renderEmptyState/);
  assert.match(adminJs, /setWorkspaceMessage/);
});

test("admin login form is forcibly hidden after authentication", () => {
  assert.match(adminJs, /classList\.add\("is-authenticated"\)/);
  assert.match(adminCss, /\.is-authenticated\s+\[data-login\]/);
  assert.match(adminCss, /display:\s*none\s*!important/);
  assert.match(adminCss, /\.console\[hidden\]/);
  assert.match(adminCss, /\.sidebar\s+\.tabs/);
  assert.match(adminCss, /body\.is-authenticated\s+\.tabs/);
  assert.match(adminCss, /\.is-authenticated\s+\[data-console\]/);
});
