import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const jsonHtml = await readFile(new URL("../public/json/index.html", import.meta.url), "utf8");
const passwordHtml = await readFile(new URL("../public/password/index.html", import.meta.url), "utf8");
const tetrisHtml = await readFile(new URL("../public/tetris/index.html", import.meta.url), "utf8");
const tetrisJs = await readFile(
  new URL("../public/assets/tetris-game.20260711.js", import.meta.url),
  "utf8",
);
const tetrisAudioJs = await readFile(
  new URL("../public/assets/tetris-audio.20260711.js", import.meta.url),
  "utf8",
);
const tetrisCss = await readFile(
  new URL("../public/assets/tetris-page.20260711.css", import.meta.url),
  "utf8",
);
const passwordJs = await readFile(
  new URL("../public/assets/password-tool.20260710.js", import.meta.url),
  "utf8",
);
const visitorNetworkJs = await readFile(
  new URL("../public/assets/visitor-network.20260710-v2.js", import.meta.url),
  "utf8",
);
const visitorNetworkCss = await readFile(
  new URL("../public/assets/visitor-network.20260710.css", import.meta.url),
  "utf8",
);
const worldClockJs = await readFile(
  new URL("../public/assets/world-clock.20260711.js", import.meta.url),
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

test("home page links to the standalone Tetris game", () => {
  assert.match(indexHtml, /href="\/tetris\/"/);
  assert.match(indexHtml, /<h3>Browser Tetris<\/h3>/);
  assert.doesNotMatch(indexHtml, /data-tetris-game/);
});

test("home page presents the site as personal developer tools and a technical blog", () => {
  assert.match(indexHtml, /Free Developer Tools &amp; Technical Blog/);
  assert.match(indexHtml, /Personal developer lab/);
  assert.match(indexHtml, /href="\/blog\/"/);
  assert.match(indexHtml, /id="tools"/);
  assert.match(indexHtml, /id="about"/);
  assert.match(indexHtml, /href="\/assets\/styles\.20260710\.css"/);
});

test("home page includes an on-demand visitor network lookup", () => {
  assert.match(indexHtml, /data-visitor-network/);
  assert.match(indexHtml, /data-network-trigger/);
  assert.match(indexHtml, /aria-controls="visitor-network-result"/);
  assert.match(indexHtml, /src="\/assets\/visitor-network\.20260710-v2\.js"/);
  assert.match(indexHtml, /href="\/assets\/visitor-network\.20260710\.css"/);
  assert.match(visitorNetworkJs, /fetch\("\/api\/public\/ip-info"/);
  assert.match(visitorNetworkJs, /"X-AI-Build-Lab-Request":\s*"visitor-network"/);
  assert.match(visitorNetworkJs, /cache:\s*"no-store"/);
  assert.match(visitorNetworkJs, /IPWhois/);
  assert.match(visitorNetworkJs, /GeoJS/);
  assert.match(visitorNetworkJs, /Too many requests/);
  assert.match(visitorNetworkCss, /\.network-button/);
  assert.match(visitorNetworkCss, /min-height:\s*44px/);
});

test("home page includes network-synchronized Beijing and Los Angeles clocks", () => {
  assert.match(indexHtml, /data-world-clocks/);
  assert.match(indexHtml, /data-clock-time="beijing"/);
  assert.match(indexHtml, /data-clock-time="los-angeles"/);
  assert.match(indexHtml, /src="\/assets\/world-clock\.20260711\.js"/);
  assert.match(worldClockJs, /fetch\("\/api\/public\/time"/);
  assert.match(worldClockJs, /"Asia\/Shanghai"/);
  assert.match(worldClockJs, /"America\/Los_Angeles"/);
  assert.match(worldClockJs, /performance\.now\(\)/);
  assert.doesNotMatch(worldClockJs, /Date\.now\(\)/);
});

test("public pages use consistent English SEO metadata", async () => {
  const pages = [indexHtml, jsonHtml, passwordHtml, tetrisHtml];
  pages.forEach((html) => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta\s+name="description"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/superstar1014\.qzz\.io\//);
    assert.match(html, /<meta property="og:locale" content="en_US"/);
    assert.match(html, /<meta property="og:site_name" content="AI Build Lab"/);
    assert.match(html, /<script type="application\/ld\+json">/);
    const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(structuredData);
    assert.ok(JSON.parse(structuredData[1])["@type"]);
  });

  const publicRoot = new URL("../public/", import.meta.url);
  const publicFiles = (await readdir(publicRoot, { recursive: true }))
    .filter((path) => /\.(?:html|js|xml|txt)$/.test(path));
  const publicText = await Promise.all(
    publicFiles.map((path) => readFile(new URL(path, publicRoot), "utf8")),
  );
  publicText.forEach((text) => assert.doesNotMatch(text, /[\p{Script=Han}]/u));
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

test("Tetris is served from a branded standalone page with keyboard controls", () => {
  assert.match(tetrisHtml, /<main class="tetris-shell" data-tetris-game/);
  assert.match(tetrisHtml, /href="https:\/\/superstar1014\.qzz\.io\/tetris\/"/);
  assert.match(tetrisHtml, /href="\/assets\/tool-brand\.20260710\.css"/);
  assert.match(tetrisHtml, /href="\/assets\/tetris-page\.20260711\.css"/);
  assert.match(tetrisHtml, /src="\/assets\/tetris-game\.20260711\.js"/);
  assert.match(tetrisHtml, /data-tetris-board/);
  assert.match(tetrisHtml, /data-next-piece/);
  assert.match(tetrisHtml, /<kbd>Space<\/kbd>/);
  assert.match(tetrisHtml, /<kbd>P<\/kbd><kbd>R<\/kbd>/);
  assert.match(tetrisCss, /aspect-ratio:\s*1\s*\/\s*2/);
  assert.match(tetrisCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Tetris keeps scores local and pauses when the page is hidden", () => {
  assert.match(tetrisJs, /ai-build-lab\.tetris-best-score\.v1/);
  assert.match(tetrisJs, /localStorage\.setItem/);
  assert.match(tetrisJs, /requestAnimationFrame/);
  assert.match(tetrisJs, /visibilitychange/);
  assert.match(tetrisJs, /document\.hidden/);
});

test("Tetris includes optional synthesized music and sound effects", () => {
  assert.match(tetrisHtml, /href="\/assets\/tetris-audio\.20260711\.js"/);
  assert.match(tetrisHtml, /data-audio-toggle="music"/);
  assert.match(tetrisHtml, /data-audio-toggle="effects"/);
  assert.match(tetrisHtml, /aria-pressed="false"/);
  assert.match(tetrisJs, /createTetrisAudio/);
  assert.match(tetrisJs, /playEffect\("lineClear"/);
  assert.match(tetrisJs, /setGameRunning/);
  assert.match(tetrisAudioJs, /ai-build-lab\.tetris-audio\.v1/);
  assert.match(tetrisAudioJs, /createOscillator/);
  assert.doesNotMatch(tetrisAudioJs, /fetch\(/);
});

test("Tetris includes touch controls for mobile gameplay", () => {
  assert.match(tetrisHtml, /data-mobile-controls/);
  assert.match(tetrisHtml, /data-touch-action="left"/);
  assert.match(tetrisHtml, /data-touch-action="right"/);
  assert.match(tetrisHtml, /data-touch-action="softDrop"/);
  assert.match(tetrisHtml, /data-touch-action="rotateLeft"/);
  assert.match(tetrisHtml, /data-touch-action="rotateRight"/);
  assert.match(tetrisHtml, /data-touch-action="hardDrop"/);
  assert.match(tetrisJs, /pointerdown/);
  assert.match(tetrisJs, /setInterval\(\(\) => performPlayerAction\(action\), 75\)/);
  assert.match(tetrisJs, /const next = togglePause\(state\)/);
  assert.match(tetrisCss, /\.mobile-control-grid/);
  assert.match(tetrisCss, /min-height:\s*58px/);
  assert.match(tetrisCss, /touch-action:\s*none/);
});

test("all standalone tool pages link to Tetris", () => {
  assert.match(jsonHtml, /href="\/tetris\/"/);
  assert.match(passwordHtml, /href="\/tetris\/"/);
  assert.match(tetrisHtml, /aria-current="page" href="\/tetris\/"/);
});

test("sitemap includes the standalone Tetris URL", () => {
  assert.match(sitemapXml, /<loc>https:\/\/superstar1014\.qzz\.io\/tetris\/<\/loc>/);
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
  assert.match(adminHtml, /data-create-label="New post"/);
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
