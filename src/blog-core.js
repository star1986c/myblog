const ARTICLE_STATUS = {
  DRAFT: "draft",
  PUBLISHED: "published",
};

const ARTICLE_VISIBILITY = {
  PRIVATE: "private",
  PUBLIC: "public",
};

function normalizeArticleInput(input = {}, options = {}) {
  const title = cleanText(input.title) || "Untitled";
  const status = input.status === ARTICLE_STATUS.PUBLISHED
    ? ARTICLE_STATUS.PUBLISHED
    : ARTICLE_STATUS.DRAFT;
  const visibility = input.visibility === ARTICLE_VISIBILITY.PUBLIC
    ? ARTICLE_VISIBILITY.PUBLIC
    : ARTICLE_VISIBILITY.PRIVATE;
  const slug = slugify(input.slug || title);
  const now = options.now || new Date().toISOString();
  const publishedAt = status === ARTICLE_STATUS.PUBLISHED
    ? cleanText(input.publishedAt) || now
    : null;

  return {
    title,
    slug,
    excerpt: cleanText(input.excerpt),
    content: typeof input.content === "string" ? input.content : "",
    status,
    visibility,
    seoTitle: cleanText(input.seoTitle),
    seoDescription: cleanText(input.seoDescription),
    publishedAt,
  };
}

function normalizeCategoryInput(input = {}) {
  const name = cleanText(input.name) || "Untitled";
  return {
    name,
    slug: slugify(input.slug || name),
    description: cleanText(input.description),
  };
}

function normalizeMediaInput(input = {}) {
  return {
    key: cleanText(input.key),
    filename: cleanText(input.filename),
    contentType: cleanText(input.contentType) || "application/octet-stream",
    size: Number.isFinite(input.size) ? input.size : 0,
    alt: cleanText(input.alt),
  };
}

function canShowPublicly(article) {
  return (
    article?.status === ARTICLE_STATUS.PUBLISHED &&
    article?.visibility === ARTICLE_VISIBILITY.PUBLIC
  );
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);

  return slug || "post";
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export {
  ARTICLE_STATUS,
  ARTICLE_VISIBILITY,
  canShowPublicly,
  normalizeArticleInput,
  normalizeCategoryInput,
  normalizeMediaInput,
  slugify,
};
