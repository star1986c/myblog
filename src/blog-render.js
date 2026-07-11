const SITE_URL = "https://superstar1014.qzz.io";

function renderBlogIndex(posts) {
  const items = posts.length
    ? posts.map(renderPostCard).join("")
    : renderEmptyState("Private drafts are still being shaped. Public notes will appear here after they are published.");

  return renderDocument({
    title: "Blog | AI Build Lab",
    description: "Practical engineering notes, Cloudflare Workers guides, AI-assisted development workflows, and product build logs from AI Build Lab.",
    canonicalPath: "/blog/",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Blog",
      "@id": `${SITE_URL}/blog/#blog`,
      url: `${SITE_URL}/blog/`,
      name: "AI Build Lab Blog",
      description: "Practical engineering notes, AI-assisted development workflows, and product build logs.",
      inLanguage: "en",
      isPartOf: { "@id": `${SITE_URL}/#website` },
    },
    body: `
      ${renderSiteHeader("blog")}
      <main class="blog-shell" id="main-content">
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
  const canonicalPath = `/blog/${encodeURIComponent(post.slug)}`;
  const description = post.seoDescription || post.excerpt || "AI Build Lab technical article.";
  return renderDocument({
    title: `${post.seoTitle || post.title} | AI Build Lab`,
    description,
    canonicalPath,
    type: "article",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.seoTitle || post.title,
      description,
      url: `${SITE_URL}${canonicalPath}`,
      mainEntityOfPage: `${SITE_URL}${canonicalPath}`,
      datePublished: post.publishedAt || post.createdAt,
      dateModified: post.updatedAt || post.publishedAt || post.createdAt,
      inLanguage: "en",
      author: { "@type": "Organization", name: "AI Build Lab", url: `${SITE_URL}/` },
      publisher: { "@type": "Organization", name: "AI Build Lab", url: `${SITE_URL}/` },
      isPartOf: { "@id": `${SITE_URL}/blog/#blog` },
    },
    body: `
      ${renderSiteHeader("blog")}
      <main class="article-shell" id="main-content">
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
  const canonicalPath = `/p/${encodeURIComponent(page.slug)}`;
  const description = page.seoDescription || page.excerpt || "An AI Build Lab standalone page.";
  return renderDocument({
    title: `${page.seoTitle || page.title} | AI Build Lab`,
    description,
    canonicalPath,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: page.seoTitle || page.title,
      description,
      url: `${SITE_URL}${canonicalPath}`,
      datePublished: page.publishedAt || page.createdAt,
      dateModified: page.updatedAt || page.publishedAt || page.createdAt,
      inLanguage: "en",
      isPartOf: { "@id": `${SITE_URL}/#website` },
    },
    body: `
      ${renderSiteHeader()}
      <main class="article-shell" id="main-content">
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
    canonicalPath: `/category/${encodeURIComponent(category.slug)}`,
    structuredData: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: `${category.name} articles`,
      description: category.description || `Public technical articles in ${category.name}.`,
      url: `${SITE_URL}/category/${encodeURIComponent(category.slug)}`,
      inLanguage: "en",
      isPartOf: { "@id": `${SITE_URL}/blog/#blog` },
    },
    body: `
      ${renderSiteHeader("blog")}
      <main class="blog-shell" id="main-content">
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
    canonicalPath: "/blog/",
    robots: "noindex,follow",
    body: `
      ${renderSiteHeader()}
      <main class="blog-shell" id="main-content">
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

function renderSiteHeader(current = "") {
  const navItems = [
    ["home", "/", "Home"],
    ["blog", "/blog/", "Blog"],
    ["json", "/json/", "JSON Formatter"],
    ["password", "/password/", "Password Generator"],
    ["tetris", "/tetris/", "Tetris"],
  ];
  const links = navItems
    .map(([key, href, label]) => `<a${key === current ? ' aria-current="page"' : ""} href="${href}">${label}</a>`)
    .join("");
  return `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="site-header">
      <a class="brand" href="/">AI Build Lab</a>
      <nav aria-label="Primary navigation">${links}</nav>
    </header>
  `;
}

function renderDocument({
  title,
  description,
  body,
  canonicalPath,
  type = "website",
  robots = "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1",
  structuredData,
}) {
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  const structuredDataMarkup = structuredData
    ? `<script type="application/ld+json">${serializeStructuredData(structuredData)}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="#050916" />
    <meta name="robots" content="${escapeHtml(robots)}" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <meta property="og:type" content="${escapeHtml(type)}" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:site_name" content="AI Build Lab" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    ${structuredDataMarkup}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="sitemap" href="/sitemap.xml" type="application/xml" />
    <link rel="stylesheet" href="/assets/blog.20260706.css" />
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

function serializeStructuredData(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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
