import {
  normalizeArticleInput,
  normalizeCategoryInput,
  normalizeMediaInput,
} from "./blog-core.js";

const POST_COLUMNS = [
  "id",
  "title",
  "slug",
  "excerpt",
  "content",
  "status",
  "visibility",
  "seo_title AS seoTitle",
  "seo_description AS seoDescription",
  "published_at AS publishedAt",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

const POST_COLUMNS_FROM_POSTS = [
  "posts.id AS id",
  "posts.title AS title",
  "posts.slug AS slug",
  "posts.excerpt AS excerpt",
  "posts.content AS content",
  "posts.status AS status",
  "posts.visibility AS visibility",
  "posts.seo_title AS seoTitle",
  "posts.seo_description AS seoDescription",
  "posts.published_at AS publishedAt",
  "posts.created_at AS createdAt",
  "posts.updated_at AS updatedAt",
].join(", ");

const PAGE_COLUMNS = POST_COLUMNS;

const CATEGORY_COLUMNS = [
  "id",
  "name",
  "slug",
  "description",
  "created_at AS createdAt",
  "updated_at AS updatedAt",
].join(", ");

const MEDIA_COLUMNS = [
  "id",
  "object_key AS key",
  "filename",
  "content_type AS contentType",
  "size",
  "alt",
  "created_at AS createdAt",
].join(", ");

function requireDatabase(env) {
  if (!env?.BLOG_DB) {
    throw new ServiceError("Blog database is not configured.", 503);
  }
  return env.BLOG_DB;
}

async function listPublicPosts(db, { limit = 50 } = {}) {
  const result = await db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts
       WHERE status = 'published' AND visibility = 'public'
       ORDER BY published_at DESC, created_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return result.results || [];
}

async function getPublicPostBySlug(db, slug) {
  return await db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts
       WHERE slug = ? AND status = 'published' AND visibility = 'public'
       LIMIT 1`,
    )
    .bind(slug)
    .first();
}

async function listAdminPosts(db) {
  const result = await db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all();
  return result.results || [];
}

async function createPost(db, input) {
  const article = normalizeArticleInput(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO posts (
        id, title, slug, excerpt, content, status, visibility,
        seo_title, seo_description, published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      article.title,
      article.slug,
      article.excerpt,
      article.content,
      article.status,
      article.visibility,
      article.seoTitle,
      article.seoDescription,
      article.publishedAt,
      now,
      now,
    )
    .run();

  return { id, ...article, createdAt: now, updatedAt: now };
}

async function updatePost(db, id, input) {
  const article = normalizeArticleInput(input);
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE posts
       SET title = ?, slug = ?, excerpt = ?, content = ?, status = ?, visibility = ?,
           seo_title = ?, seo_description = ?, published_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      article.title,
      article.slug,
      article.excerpt,
      article.content,
      article.status,
      article.visibility,
      article.seoTitle,
      article.seoDescription,
      article.publishedAt,
      now,
      id,
    )
    .run();

  return { id, ...article, updatedAt: now };
}

async function deletePost(db, id) {
  await db.prepare("DELETE FROM post_categories WHERE post_id = ?").bind(id).run();
  await db.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
}

async function listPublicPages(db) {
  const result = await db
    .prepare(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       WHERE status = 'published' AND visibility = 'public'
       ORDER BY updated_at DESC`,
    )
    .all();
  return result.results || [];
}

async function getPublicPageBySlug(db, slug) {
  return await db
    .prepare(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       WHERE slug = ? AND status = 'published' AND visibility = 'public'
       LIMIT 1`,
    )
    .bind(slug)
    .first();
}

async function listAdminPages(db) {
  const result = await db
    .prepare(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all();
  return result.results || [];
}

async function createPage(db, input) {
  const page = normalizeArticleInput(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO pages (
        id, title, slug, excerpt, content, status, visibility,
        seo_title, seo_description, published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      page.title,
      page.slug,
      page.excerpt,
      page.content,
      page.status,
      page.visibility,
      page.seoTitle,
      page.seoDescription,
      page.publishedAt,
      now,
      now,
    )
    .run();

  return { id, ...page, createdAt: now, updatedAt: now };
}

async function updatePage(db, id, input) {
  const page = normalizeArticleInput(input);
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE pages
       SET title = ?, slug = ?, excerpt = ?, content = ?, status = ?, visibility = ?,
           seo_title = ?, seo_description = ?, published_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      page.title,
      page.slug,
      page.excerpt,
      page.content,
      page.status,
      page.visibility,
      page.seoTitle,
      page.seoDescription,
      page.publishedAt,
      now,
      id,
    )
    .run();

  return { id, ...page, updatedAt: now };
}

async function deletePage(db, id) {
  await db.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
}

async function listCategories(db) {
  const result = await db
    .prepare(`SELECT ${CATEGORY_COLUMNS} FROM categories ORDER BY name ASC`)
    .all();
  return result.results || [];
}

async function createCategory(db, input) {
  const category = normalizeCategoryInput(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO categories (id, name, slug, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, category.name, category.slug, category.description, now, now)
    .run();

  return { id, ...category, createdAt: now, updatedAt: now };
}

async function updateCategory(db, id, input) {
  const category = normalizeCategoryInput(input);
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE categories
       SET name = ?, slug = ?, description = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(category.name, category.slug, category.description, now, id)
    .run();

  return { id, ...category, updatedAt: now };
}

async function deleteCategory(db, id) {
  await db.prepare("DELETE FROM post_categories WHERE category_id = ?").bind(id).run();
  await db.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
}

async function listPublicPostsByCategory(db, slug) {
  const result = await db
    .prepare(
      `SELECT ${POST_COLUMNS_FROM_POSTS}
       FROM posts
       INNER JOIN post_categories ON post_categories.post_id = posts.id
       INNER JOIN categories ON categories.id = post_categories.category_id
       WHERE categories.slug = ?
         AND posts.status = 'published'
         AND posts.visibility = 'public'
       ORDER BY posts.published_at DESC, posts.created_at DESC`,
    )
    .bind(slug)
    .all();
  return result.results || [];
}

async function getCategoryBySlug(db, slug) {
  return await db
    .prepare(`SELECT ${CATEGORY_COLUMNS} FROM categories WHERE slug = ? LIMIT 1`)
    .bind(slug)
    .first();
}

async function listMediaAssets(db) {
  const result = await db
    .prepare(`SELECT ${MEDIA_COLUMNS} FROM media_assets ORDER BY created_at DESC`)
    .all();
  return result.results || [];
}

async function createMediaAsset(db, input) {
  const media = normalizeMediaInput(input);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO media_assets (
        id, object_key, filename, content_type, size, alt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, media.key, media.filename, media.contentType, media.size, media.alt, now)
    .run();

  return { id, ...media, createdAt: now };
}

class ServiceError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export {
  ServiceError,
  createCategory,
  createMediaAsset,
  createPage,
  createPost,
  deleteCategory,
  deletePage,
  deletePost,
  getCategoryBySlug,
  getPublicPageBySlug,
  getPublicPostBySlug,
  listAdminPages,
  listAdminPosts,
  listCategories,
  listMediaAssets,
  listPublicPages,
  listPublicPosts,
  listPublicPostsByCategory,
  requireDatabase,
  updateCategory,
  updatePage,
  updatePost,
};
