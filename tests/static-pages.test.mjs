import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const jsonHtml = await readFile(new URL("../public/json/index.html", import.meta.url), "utf8");
const tetrisHtml = await readFile(new URL("../public/tetris/index.html", import.meta.url), "utf8");
const matchThreeHtml = await readFile(new URL("../public/block-puzzle/index.html", import.meta.url), "utf8");
const matchThreeJs = await readFile(
  new URL("../public/assets/match-three.20260716.js", import.meta.url),
  "utf8",
);
const matchThreeCss = await readFile(
  new URL("../public/assets/match-three.20260716.css", import.meta.url),
  "utf8",
);
const matchThreeMotionJs = await readFile(
  new URL("../public/assets/match-three-motion.20260717.js", import.meta.url),
  "utf8",
);
const matchThreeMotionCss = await readFile(
  new URL("../public/assets/match-three-motion.20260717.css", import.meta.url),
  "utf8",
);
const matchThreeCoreJs = await readFile(
  new URL("../public/assets/match-three-core.20260716.js", import.meta.url),
  "utf8",
);
const mobileGameEntryCss = await readFile(
  new URL("../public/assets/mobile-game-entry.20260716.css", import.meta.url),
  "utf8",
);
const tetrisAutoJs = await readFile(
  new URL("../public/assets/tetris-auto.20260712-v2.js", import.meta.url),
  "utf8",
);
const tetrisLegacyJs = await readFile(
  new URL("../public/assets/tetris-game.20260712.js", import.meta.url),
  "utf8",
);
const tetrisJs = `${tetrisAutoJs}\n${tetrisLegacyJs}`;
const tetrisAudioJs = await readFile(
  new URL("../public/assets/tetris-audio.20260712.js", import.meta.url),
  "utf8",
);
const tetrisCss = [
  await readFile(new URL("../public/assets/tetris-page.20260712-v2.css", import.meta.url), "utf8"),
  await readFile(new URL("../public/assets/tetris-page.20260712.css", import.meta.url), "utf8"),
  await readFile(new URL("../public/assets/tetris-page.20260711.css", import.meta.url), "utf8"),
].join("\n");
const visitorNetworkJs = await readFile(
  new URL("../public/assets/visitor-network.20260710-v2.js", import.meta.url),
  "utf8",
);
const visitorNetworkCss = await readFile(
  new URL("../public/assets/visitor-network.20260710.css", import.meta.url),
  "utf8",
);
const worldClockJs = await readFile(
  new URL("../public/assets/world-clock.20260711-v2.js", import.meta.url),
  "utf8",
);
const notesHtml = await readFile(new URL("../public/notes/index.html", import.meta.url), "utf8");
const notesJs = await readFile(
  new URL("../public/assets/notes.20260813-v3.js", import.meta.url),
  "utf8",
);
const notesCss = await readFile(
  new URL("../public/assets/notes.20260813-v2.css", import.meta.url),
  "utf8",
);
const encryptedNotesCoreJs = await readFile(
  new URL("../public/assets/encrypted-notes-core.20260813-v2.js", import.meta.url),
  "utf8",
);
const sitemapXml = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

test("home page links to the JSON tool without embedding the formatter", () => {
  assert.match(indexHtml, /href="\/json\/"/);
  assert.doesNotMatch(indexHtml, /data-json-tool/);
  assert.doesNotMatch(indexHtml, /json-tool\.20260706\.js/);
  assert.doesNotMatch(indexHtml, /styles\.20260706-json\.css/);
});

test("home page removes the standalone password generator", () => {
  assert.doesNotMatch(indexHtml, /href="\/password\/"|Password Generator/);
});

test("home page links to the standalone Tetris game", () => {
  assert.match(indexHtml, /href="\/tetris\/"/);
  assert.match(indexHtml, /<h3>Browser Tetris<\/h3>/);
  assert.doesNotMatch(indexHtml, /data-tetris-game/);
});

test("home page offers the separate match-three game only through a mobile entry", () => {
  assert.match(indexHtml, /href="\/block-puzzle\/"/);
  assert.match(indexHtml, /class="mobile-game-entry"/);
  assert.match(indexHtml, /Play Mobile Match Three/);
  assert.match(indexHtml, /href="\/assets\/mobile-game-entry\.20260716\.css"/);
  assert.match(mobileGameEntryCss, /\.mobile-game-entry\s*\{\s*display:\s*none/);
  assert.match(mobileGameEntryCss, /@media \(max-width:\s*700px\)/);
  assert.match(mobileGameEntryCss, /min-height:\s*72px/);
});

test("home page keeps the developer tools and links to private notes", () => {
  assert.match(indexHtml, /Developer Tools &amp; Private Notes/);
  assert.match(indexHtml, /Personal developer lab/);
  assert.match(indexHtml, /href="\/notes\/"/);
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
  assert.match(indexHtml, /src="\/assets\/world-clock\.20260711-v2\.js"/);
  assert.match(worldClockJs, /fetch\("\/api\/public\/time"/);
  assert.match(worldClockJs, /"Asia\/Shanghai"/);
  assert.match(worldClockJs, /"America\/Los_Angeles"/);
  assert.match(worldClockJs, /performance\.now\(\)/);
  assert.doesNotMatch(worldClockJs, /Date\.now\(\)/);
});

test("public pages use consistent English SEO metadata", async () => {
  const pages = [indexHtml, jsonHtml, tetrisHtml, matchThreeHtml];
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
    .filter((path) => /\.(?:html|js|xml|txt)$/.test(path))
    .filter((path) => !path.startsWith("notes/"))
    .filter((path) => !path.includes("notes.20260813"))
    .filter((path) => !path.includes("encrypted-notes-core.20260813"));
  const publicText = await Promise.all(
    publicFiles.map((path) => readFile(new URL(path, publicRoot), "utf8")),
  );
  publicText.forEach((text) => assert.doesNotMatch(text, /[\p{Script=Han}]/u));
});

test("private notes page encrypts all note fields locally and is excluded from indexing", () => {
  assert.match(notesHtml, /<html lang="zh-Hans">/);
  assert.match(notesHtml, /name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex"/);
  assert.match(notesHtml, /data-workspace-loading/);
  assert.match(notesHtml, /data-settings-dialog/);
  assert.match(notesHtml, /data-settings-form/);
  assert.doesNotMatch(notesHtml, /data-vault-|主密码|\/admin\//);
  assert.match(notesHtml, /data-note-title/);
  assert.match(notesHtml, /data-note-content/);
  assert.match(notesHtml, /src="\/assets\/notes\.20260813-v3\.js"/);
  assert.match(notesHtml, /href="\/assets\/notes\.20260813-v2\.css"/);
  assert.match(notesJs, /encryptNote/);
  assert.match(notesJs, /decryptNote/);
  assert.match(notesJs, /\/api\/admin\/encrypted-notes/);
  assert.match(notesJs, /\/api\/admin\/workspace-key/);
  assert.match(notesJs, /\/api\/admin\/account/);
  assert.match(notesJs, /importNoteDataKey/);
  assert.match(notesJs, /IDLE_LOCK_MS = 5 \* 60 \* 1000/);
  assert.match(notesJs, /HIDDEN_LOCK_MS = 60 \* 1000/);
  const loginHandler = notesJs.match(/async function handleLogin\(event\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.ok(loginHandler.indexOf("new FormData") < loginHandler.indexOf("setFormBusy"));
  assert.match(loginHandler, /body:\s*\{\s*username,\s*password/);
  assert.doesNotMatch(notesJs, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(notesJs, /masterPassword|password-vault|unlockPasswordVault/);
  assert.match(encryptedNotesCoreJs, /AES-GCM/);
  assert.match(encryptedNotesCoreJs, /encrypted-note:/);
  assert.match(encryptedNotesCoreJs, /getRandomValues/);
  assert.match(encryptedNotesCoreJs, /importNoteDataKey/);
  assert.match(notesCss, /@media \(max-width: 760px\)/);
  assert.match(notesCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("private routes are absent from the public sitemap", () => {
  assert.doesNotMatch(sitemapXml, /\/blog\/|\/notes\/|\/admin\//);
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

test("sitemap excludes retired password and admin pages", () => {
  assert.doesNotMatch(sitemapXml, /\/password\/|\/admin\//);
});

test("Tetris is served from a branded standalone page with keyboard controls", () => {
  assert.match(tetrisHtml, /<main class="tetris-shell" data-tetris-game/);
  assert.match(tetrisHtml, /href="https:\/\/superstar1014\.qzz\.io\/tetris\/"/);
  assert.match(tetrisHtml, /href="\/assets\/tool-brand\.20260710\.css"/);
  assert.match(tetrisHtml, /href="\/assets\/tetris-page\.20260712-v2\.css"/);
  assert.match(tetrisHtml, /src="\/assets\/tetris-auto\.20260712-v2\.js"/);
  assert.match(tetrisHtml, /data-tetris-board/);
  assert.match(tetrisHtml, /data-next-piece/);
  assert.match(tetrisHtml, /<kbd>Space<\/kbd>/);
  assert.match(tetrisHtml, /<kbd>P<\/kbd><kbd>R<\/kbd>/);
  assert.match(tetrisCss, /@import url\("\.\/tetris-page\.20260712\.css"\)/);
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
  assert.match(tetrisHtml, /href="\/assets\/tetris-audio\.20260712\.js"/);
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

test("Tetris automatically triggers random power-ups and shows the current effect", () => {
  assert.match(tetrisHtml, /data-game-mode="classic"/);
  assert.match(tetrisHtml, /data-game-mode="powerup"/);
  assert.match(tetrisHtml, /data-random-power-panel/);
  assert.match(tetrisHtml, /data-current-power-status/);
  assert.match(tetrisHtml, /Triggers automatically/);
  assert.match(tetrisHtml, /automatic-power-engine[^>]*hidden[^>]*aria-hidden="true"/);
  assert.doesNotMatch(tetrisHtml, /<kbd>1<\/kbd>|<kbd>2<\/kbd>|<kbd>3<\/kbd>/);
  assert.match(tetrisJs, /ai-build-lab\.tetris-best-score\.powerup\.v1/);
  assert.match(tetrisAutoJs, /chooseRandomPowerUp/);
  assert.match(tetrisAutoJs, /stopImmediatePropagation/);
  assert.match(tetrisAutoJs, /INSTANT_EFFECT_VISIBLE_MS = 2500/);
  assert.match(tetrisCss, /\.current-power-status/);
  assert.match(tetrisCss, /\.automatic-power-engine/);
  assert.match(tetrisCss, /transition-duration:\s*0\.01ms/);
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

test("desktop Tetris keeps its existing modes while phones get a separate match-three link", () => {
  assert.match(tetrisHtml, /data-game-mode="classic"/);
  assert.match(tetrisHtml, /data-game-mode="powerup"/);
  assert.match(tetrisHtml, /class="mobile-game-entry" href="\/block-puzzle\/"/);
  assert.match(tetrisHtml, /href="\/assets\/mobile-game-entry\.20260716\.css"/);
  assert.match(tetrisHtml, /Try Mobile Match Three/);
  assert.doesNotMatch(tetrisJs, /match-three|matchthree/);
});

test("mobile match-three is served from the existing route with new fingerprinted assets", () => {
  assert.match(matchThreeHtml, /<main class="match-shell" data-match-three/);
  assert.match(matchThreeHtml, /href="https:\/\/superstar1014\.qzz\.io\/block-puzzle\/"/);
  assert.match(matchThreeHtml, /href="\/assets\/match-three\.20260716\.css"/);
  assert.match(matchThreeHtml, /href="\/assets\/match-three-core\.20260716\.js"/);
  assert.match(matchThreeHtml, /src="\/assets\/match-three\.20260716\.js"/);
  assert.match(matchThreeHtml, /src="\/assets\/match-three-motion\.20260717\.js"/);
  assert.match(matchThreeHtml, /href="\/assets\/match-three-motion\.20260717\.css"/);
  assert.match(matchThreeHtml, /data-match-board/);
  assert.match(matchThreeHtml, /data-goal-progress/);
  assert.match(matchThreeHtml, /data-power-status/);
  assert.match(matchThreeHtml, /data-overlay-primary/);
  assert.match(matchThreeHtml, /Mobile Match-3 Puzzle Game/);
});

test("mobile match-three uses accessible tap and swipe controls with isolated persistence", () => {
  assert.match(matchThreeJs, /ai-build-lab\.match-three-best-score\.v1/);
  assert.match(matchThreeJs, /localStorage\.setItem/);
  assert.match(matchThreeJs, /visibilitychange/);
  assert.match(matchThreeJs, /pointerdown/);
  assert.match(matchThreeJs, /pointerup/);
  assert.match(matchThreeJs, /selectMatchGem/);
  assert.match(matchThreeJs, /aria-label/);
  assert.match(matchThreeCoreJs, /MATCH_THREE_STARTING_MOVES = 30/);
  assert.match(matchThreeCoreJs, /ROW_ROCKET/);
  assert.match(matchThreeCoreJs, /RAINBOW/);
  assert.match(matchThreeCoreJs, /BOMB/);
  assert.match(matchThreeCss, /height:\s*100dvh/);
  assert.match(matchThreeCss, /env\(safe-area-inset-top\)/);
  assert.match(matchThreeCss, /width:\s*44px/);
  assert.match(matchThreeCss, /touch-action:\s*none/);
  assert.match(matchThreeCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(matchThreeMotionJs, /MutationObserver/);
  assert.match(matchThreeMotionJs, /attributeOldValue:\s*true/);
  assert.match(matchThreeMotionJs, /prefers-reduced-motion:\s*reduce/);
  assert.match(matchThreeMotionJs, /powerStatus\.dataset\.action === "triggered"/);
  assert.match(matchThreeMotionJs, /collectMatchedIndices/);
  assert.match(matchThreeMotionJs, /addEventListener\("pointerup"/);
  assert.match(matchThreeMotionJs, /match-clear-burst/);
  assert.match(matchThreeMotionJs, /match-power-fx/);
  assert.match(matchThreeMotionCss, /@keyframes match-gem-dissolve/);
  assert.match(matchThreeMotionCss, /@keyframes match-gem-arrive/);
  assert.match(matchThreeMotionCss, /@keyframes match-clear-spark/);
  assert.match(matchThreeMotionCss, /@keyframes match-row-beam/);
  assert.match(matchThreeMotionCss, /@keyframes match-column-beam/);
  assert.match(matchThreeMotionCss, /@keyframes match-rainbow-ring/);
  assert.match(matchThreeMotionCss, /@keyframes match-bomb-wave/);
  assert.match(matchThreeMotionCss, /@keyframes match-invalid-return/);
  assert.match(matchThreeMotionCss, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(matchThreeHtml, /http-equiv="refresh"/);
  assert.doesNotMatch(matchThreeJs, /userAgent|location\.replace/);
});

test("all standalone tool pages link to Tetris", () => {
  assert.match(jsonHtml, /href="\/tetris\/"/);
  assert.match(tetrisHtml, /aria-current="page" href="\/tetris\/"/);
});

test("sitemap includes the standalone Tetris URL", () => {
  assert.match(sitemapXml, /<loc>https:\/\/superstar1014\.qzz\.io\/tetris\/<\/loc>/);
});

test("sitemap includes the standalone mobile match-three URL", () => {
  assert.match(sitemapXml, /<loc>https:\/\/superstar1014\.qzz\.io\/block-puzzle\/<\/loc>/);
});
