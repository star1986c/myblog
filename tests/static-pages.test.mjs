import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const jsonHtml = await readFile(new URL("../public/json/index.html", import.meta.url), "utf8");
const sitemapXml = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");

test("home page links to the JSON tool without embedding the formatter", () => {
  assert.match(indexHtml, /href="\/json\/"/);
  assert.doesNotMatch(indexHtml, /data-json-tool/);
  assert.doesNotMatch(indexHtml, /json-tool\.20260706\.js/);
  assert.doesNotMatch(indexHtml, /styles\.20260706-json\.css/);
});

test("JSON formatter is served from a standalone page", () => {
  assert.match(jsonHtml, /<main class="tool-shell" data-json-tool>/);
  assert.match(jsonHtml, /href="https:\/\/superstar1014\.qzz\.io\/json\/"/);
  assert.match(jsonHtml, /href="\/assets\/json-page\.20260706\.css"/);
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
