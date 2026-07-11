import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_STATUS,
  ARTICLE_VISIBILITY,
  canShowPublicly,
  normalizeArticleInput,
  normalizeMediaInput,
  slugify,
} from "../src/blog-core.js";

test("normalizes new articles as draft and private by default", () => {
  const article = normalizeArticleInput({
    title: "My First Cloudflare Blog",
    content: "Hello from D1.",
  });

  assert.equal(article.status, ARTICLE_STATUS.DRAFT);
  assert.equal(article.visibility, ARTICLE_VISIBILITY.PRIVATE);
  assert.equal(article.title, "My First Cloudflare Blog");
  assert.equal(article.slug, "my-first-cloudflare-blog");
});

test("does not make an article public unless visibility is explicitly public", () => {
  const article = normalizeArticleInput({
    title: "Private Launch Notes",
    content: "Internal notes",
    status: "published",
    visibility: "unexpected",
  });

  assert.equal(article.status, ARTICLE_STATUS.PUBLISHED);
  assert.equal(article.visibility, ARTICLE_VISIBILITY.PRIVATE);
});

test("public visibility requires both published status and public visibility", () => {
  assert.equal(canShowPublicly({ status: "draft", visibility: "public" }), false);
  assert.equal(canShowPublicly({ status: "published", visibility: "private" }), false);
  assert.equal(canShowPublicly({ status: "published", visibility: "public" }), true);
});

test("slugify creates stable URL slugs", () => {
  assert.equal(slugify("  Hello, Cloudflare Workers!  "), "hello-cloudflare-workers");
  assert.equal(slugify("Заголовок"), "post");
});

test("normalizes manually entered media URLs", () => {
  const media = normalizeMediaInput({
    url: " https://cdn.example.com/hero.png ",
    alt: " Hero image ",
  });

  assert.equal(media.url, "https://cdn.example.com/hero.png");
  assert.equal(media.filename, "hero.png");
  assert.equal(media.alt, "Hero image");
});
