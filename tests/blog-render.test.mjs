import assert from "node:assert/strict";
import test from "node:test";
import {
  renderBlogIndex,
  renderCategory,
  renderPost,
} from "../src/blog-render.js";

const samplePost = {
  title: "Shipping a Personal Blog on Workers",
  slug: "workers-blog",
  excerpt: "Notes on D1, admin flows, and content publishing.",
  content: "First paragraph.\n\nSecond paragraph.",
  publishedAt: "2026-07-07T10:00:00.000Z",
  createdAt: "2026-07-06T10:00:00.000Z",
};

test("blog index renders a polished public landing surface", () => {
  const html = renderBlogIndex([samplePost]);

  assert.match(html, /class="blog-hero"/);
  assert.match(html, /class="blog-stats"/);
  assert.match(html, /1 public note/);
  assert.match(html, /class="post-card__action"/);
  assert.match(html, /Read article/);
});

test("blog index renders a designed empty state", () => {
  const html = renderBlogIndex([]);

  assert.match(html, /class="empty-state"/);
  assert.match(html, /Private drafts are still being shaped/);
});

test("article page renders reading-focused chrome", () => {
  const html = renderPost(samplePost);

  assert.match(html, /class="article-back"/);
  assert.match(html, /Back to blog/);
  assert.match(html, /class="article-header"/);
  assert.match(html, /<time datetime="2026-07-07T10:00:00.000Z">2026-07-07<\/time>/);
  assert.match(html, /class="article-content"/);
});

test("category page shares the blog hero treatment", () => {
  const html = renderCategory(
    { name: "Cloudflare", description: "Workers, D1, and deployment notes." },
    [samplePost],
  );

  assert.match(html, /class="blog-hero"/);
  assert.match(html, /Category/);
  assert.match(html, /Workers, D1, and deployment notes/);
});
