function renderBlogIndex(posts) {
  const items = posts.length
    ? posts.map(renderPostCard).join("")
    : `<p class="empty">No public posts yet.</p>`;

  return renderDocument({
    title: "Blog | AI Build Lab",
    description: "Notes and build logs from AI Build Lab.",
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="blog-shell">
        <section class="blog-heading">
          <p>Blog</p>
          <h1>Build notes and field logs.</h1>
        </section>
        <section class="post-list">${items}</section>
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
        <article class="article">
          <p class="meta">${escapeHtml(formatDate(post.publishedAt || post.createdAt))}</p>
          <h1>${escapeHtml(post.title)}</h1>
          ${post.excerpt ? `<p class="excerpt">${escapeHtml(post.excerpt)}</p>` : ""}
          <div class="content">${renderContent(post.content)}</div>
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
        <article class="article">
          <h1>${escapeHtml(page.title)}</h1>
          ${page.excerpt ? `<p class="excerpt">${escapeHtml(page.excerpt)}</p>` : ""}
          <div class="content">${renderContent(page.content)}</div>
        </article>
      </main>
    `,
  });
}

function renderCategory(category, posts) {
  const items = posts.length
    ? posts.map(renderPostCard).join("")
    : `<p class="empty">No public posts in this category yet.</p>`;

  return renderDocument({
    title: `${category.name} | AI Build Lab`,
    description: category.description || `Posts in ${category.name}.`,
    body: `
      <header class="site-header">
        <a class="brand" href="/">AI Build Lab</a>
        <nav><a href="/blog/">Blog</a><a href="/json/">JSON Tool</a></nav>
      </header>
      <main class="blog-shell">
        <section class="blog-heading">
          <p>Category</p>
          <h1>${escapeHtml(category.name)}</h1>
          ${category.description ? `<span>${escapeHtml(category.description)}</span>` : ""}
        </section>
        <section class="post-list">${items}</section>
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
        <section class="blog-heading">
          <p>Blog</p>
          <h1>Blog backend is being configured.</h1>
        </section>
      </main>
    `,
  });
}

function renderPostCard(post) {
  return `
    <article class="post-card">
      <a href="/blog/${encodeURIComponent(post.slug)}">
        <span>${escapeHtml(formatDate(post.publishedAt || post.createdAt))}</span>
        <h2>${escapeHtml(post.title)}</h2>
        ${post.excerpt ? `<p>${escapeHtml(post.excerpt)}</p>` : ""}
      </a>
    </article>
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
