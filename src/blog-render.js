function renderBlogIndex(posts) {
  const items = posts.length
    ? posts.map(renderPostCard).join("")
    : renderEmptyState("Private drafts are still being shaped. Public notes will appear here after they are published.");

  return renderDocument({
    title: "Blog | AI Build Lab",
    description: "Notes and build logs from AI Build Lab.",
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/blog/">Blog</a><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="blog-shell">
        ${renderBlogHero({
          eyebrow: "AI Build Lab Journal",
          title: "Build notes, release logs, and useful experiments.",
          description: "A quiet notebook for Cloudflare Workers, AI tooling, small product decisions, and the practical details behind this personal site.",
          count: posts.length,
          countLabel: `${posts.length} public ${posts.length === 1 ? "note" : "notes"}`,
        })}
        <section class="post-list" aria-label="Published notes">${items}</section>
      </main>
    `,
  });
}

function renderPost(post) {
  return renderDocument({
    title: `${post.seoTitle || post.title} | AI Build Lab`,
    description: post.seoDescription || post.excerpt || "AI Build Lab blog post.",
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/blog/">Blog</a><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="article-shell">
        <a class="article-back" href="/blog/">Back to blog</a>
        <article class="article">
          <header class="article-header">
            ${renderDate(post.publishedAt || post.createdAt)}
            <h1>${escapeHtml(post.title)}</h1>
            ${post.excerpt ? `<p class="excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          </header>
          <div class="article-content">${renderContent(post.content)}</div>
        </article>
      </main>
    `,
  });
}

function renderStandalonePage(page) {
  return renderDocument({
    title: `${page.seoTitle || page.title} | AI Build Lab`,
    description: page.seoDescription || page.excerpt || "AI Build Lab page.",
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/blog/">Blog</a><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="article-shell">
        <article class="article article--page">
          <header class="article-header">
            <h1>${escapeHtml(page.title)}</h1>
            ${page.excerpt ? `<p class="excerpt">${escapeHtml(page.excerpt)}</p>` : ""}
          </header>
          <div class="article-content">${renderContent(page.content)}</div>
        </article>
      </main>
    `,
  });
}

function renderCategory(category, posts) {
  const items = posts.length
    ? posts.map(renderPostCard).join("")
    : renderEmptyState("No public posts in this category yet.");

  return renderDocument({
    title: `${category.name} | AI Build Lab`,
    description: category.description || `Posts in ${category.name}.`,
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/blog/">Blog</a><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="blog-shell">
        ${renderBlogHero({
          eyebrow: "Category",
          title: category.name,
          description: category.description,
          count: posts.length,
          countLabel: `${posts.length} public ${posts.length === 1 ? "note" : "notes"}`,
        })}
        <section class="post-list" aria-label="Category notes">${items}</section>
      </main>
    `,
  });
}

function renderBlogNotConfigured() {
  return renderDocument({
    title: "Blog | AI Build Lab",
    description: "Blog backend is being configured.",
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="blog-shell">
        <section class="blog-hero">
          <div class="blog-hero__copy">
          <p class="eyebrow">Blog</p>
          <h1>Blog backend is being configured.</h1>
          </div>
        </section>
      </main>
    `,
  });
}

function renderPostCard(post) {
  const dateValue = post.publishedAt || post.createdAt;
  return `
    <article class="post-card">
      <a class="post-card__link" href="/blog/${encodeURIComponent(post.slug)}">
        <div class="post-card__meta">
          ${renderDate(dateValue)}
          <span>Published note</span>
        </div>
        <div class="post-card__body">
          <h2>${escapeHtml(post.title)}</h2>
          ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
        </div>
        <span class="post-card__action">Read article</span>
      </a>
    </article>
  `;
}

function renderBlogHero({ eyebrow, title, description, count, countLabel }) {
  return `
    <section class="blog-hero">
      <div class="blog-hero__copy">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<span>${escapeHtml(description)}</span>` : ""}
      </div>
      <aside class="blog-stats" aria-label="Blog summary">
        <strong>${escapeHtml(String(count))}</strong>
        <span>${escapeHtml(countLabel)}</span>
        <small>Published when notes are ready, not when drafts are saved.</small>
      </aside>
    </section>
  `;
}

function renderEmptyState(message) {
  return `
    <div class="empty-state">
      <strong>No public posts yet</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderDocument({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#050916" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/assets/blog.20260706.css" />
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function renderContent(content) {
  const escaped = escapeHtml(content || "");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function renderDate(value) {
  const formatted = formatDate(value);
  return formatted
    ? `<p class="meta"><time datetime="${escapeHtml(value)}">${escapeHtml(formatted)}</time></p>`
    : "";
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export {
  renderBlogIndex,
  renderBlogNotConfigured,
  renderCategory,
  renderPost,
  renderStandalonePage,
};
