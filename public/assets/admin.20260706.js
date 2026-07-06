const state = {
  csrfToken: "",
  activeTab: "posts",
  posts: [],
  pages: [],
  categories: [],
  media: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const loginForm = $("[data-login]");
const loginMessage = $("[data-login-message]");
const consoleEl = $("[data-console]");
const logoutButton = $("[data-logout]");

init();

async function init() {
  bindTabs();
  bindForms();
  const session = await api("/api/auth/me");
  if (session.authenticated) {
    state.csrfToken = session.csrfToken;
    showConsole();
    await loadAll();
  }
}

function bindTabs() {
  $$("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.activeTab = button.dataset.tab;
      $$("[data-tab]").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      $$("[data-panel]").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.panel === state.activeTab);
      });
      $("[data-section-label]").textContent = button.textContent;
      resetCurrentForm();
      await loadAll();
    });
  });
}

function bindForms() {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginMessage.textContent = "";
    try {
      const body = Object.fromEntries(new FormData(loginForm));
      const result = await api("/api/auth/login", {
        method: "POST",
        body,
      });
      state.csrfToken = result.csrfToken;
      showConsole();
      await loadAll();
    } catch (error) {
      loginMessage.textContent = error.message;
    }
  });

  logoutButton.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  });

  $("[data-create]").addEventListener("click", resetCurrentForm);
  $("[data-post-form]").addEventListener("submit", savePost);
  $("[data-page-form]").addEventListener("submit", savePage);
  $("[data-category-form]").addEventListener("submit", saveCategory);
  $("[data-media-form]").addEventListener("submit", uploadMedia);
  $("[data-delete-post]").addEventListener("click", () => removeResource("posts", $("[data-post-form]")));
  $("[data-delete-page]").addEventListener("click", () => removeResource("pages", $("[data-page-form]")));
  $("[data-delete-category]").addEventListener("click", () => removeResource("categories", $("[data-category-form]")));
}

function showConsole() {
  loginForm.hidden = true;
  consoleEl.hidden = false;
  logoutButton.hidden = false;
}

async function loadAll() {
  if (state.activeTab === "posts") {
    state.posts = (await api("/api/admin/posts")).posts;
    renderList("post", state.posts);
  }
  if (state.activeTab === "pages") {
    state.pages = (await api("/api/admin/pages")).pages;
    renderList("page", state.pages);
  }
  if (state.activeTab === "categories") {
    state.categories = (await api("/api/admin/categories")).categories;
    renderList("category", state.categories);
  }
  if (state.activeTab === "media") {
    state.media = (await api("/api/admin/media")).media;
    renderMedia();
  }
}

function renderList(type, items) {
  const list = $(`[data-${type}-list]`);
  list.replaceChildren();
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "list-item";
    button.innerHTML = `
      <strong>${escapeHtml(item.title || item.name)}</strong>
      <span>${escapeHtml(item.slug || "")}</span>
      ${item.visibility ? `<span>${item.status} / ${item.visibility}</span>` : ""}
    `;
    button.addEventListener("click", () => fillForm(type, item));
    list.append(button);
  }
}

function renderMedia() {
  const list = $("[data-media-list]");
  list.replaceChildren();
  for (const item of state.media) {
    const card = document.createElement("article");
    card.className = "media-card";
    card.innerHTML = `
      <img src="/media/${encodeURIComponent(item.key)}" alt="${escapeHtml(item.alt || item.filename)}" />
      <code>/media/${escapeHtml(item.key)}</code>
    `;
    list.append(card);
  }
}

function fillForm(type, item) {
  const form = $(`[data-${type}-form]`);
  for (const [key, value] of Object.entries(item)) {
    if (form.elements[key]) {
      form.elements[key].value = value || "";
    }
  }
}

function resetCurrentForm() {
  const form = $(`[data-${singular(state.activeTab)}-form]`);
  if (!form) {
    return;
  }
  form.reset();
  if (form.elements.id) {
    form.elements.id.value = "";
  }
  if (form.elements.status) {
    form.elements.status.value = "draft";
  }
  if (form.elements.visibility) {
    form.elements.visibility.value = "private";
  }
}

async function savePost(event) {
  event.preventDefault();
  await saveResource("posts", event.currentTarget);
}

async function savePage(event) {
  event.preventDefault();
  await saveResource("pages", event.currentTarget);
}

async function saveCategory(event) {
  event.preventDefault();
  await saveResource("categories", event.currentTarget);
}

async function saveResource(collection, form) {
  const body = Object.fromEntries(new FormData(form));
  const id = body.id;
  delete body.id;
  await api(id ? `/api/admin/${collection}/${encodeURIComponent(id)}` : `/api/admin/${collection}`, {
    method: id ? "PUT" : "POST",
    body,
  });
  resetCurrentForm();
  await loadAll();
}

async function removeResource(collection, form) {
  const id = form.elements.id?.value;
  if (!id) {
    return;
  }
  await api(`/api/admin/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  resetCurrentForm();
  await loadAll();
}

async function uploadMedia(event) {
  event.preventDefault();
  const response = await fetch("/api/admin/media", {
    method: "POST",
    headers: { "X-CSRF-Token": state.csrfToken },
    body: new FormData(event.currentTarget),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  event.currentTarget.reset();
  await loadAll();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD"].includes(options.method || "GET") && state.csrfToken) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body && !(options.body instanceof FormData)
      ? JSON.stringify(options.body)
      : options.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function singular(collection) {
  if (collection === "posts") return "post";
  if (collection === "pages") return "page";
  if (collection === "categories") return "category";
  return collection;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
