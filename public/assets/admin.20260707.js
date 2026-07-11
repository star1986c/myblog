const state = {
  csrfToken: "",
  activeTab: "posts",
  posts: [],
  pages: [],
  categories: [],
  media: [],
  account: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const loginForm = $("[data-login]");
const loginMessage = $("[data-login-message]");
const accountMessage = $("[data-account-message]");
const consoleEl = $("[data-console]");
const logoutButton = $("[data-logout]");
const createButton = $("[data-create]");
const sectionLabel = $("[data-section-label]");
const sectionTitle = $("[data-section-title]");
const sectionDescription = $("[data-section-description]");
const workspaceMessage = $("[data-workspace-message]");

init();

async function init() {
  bindTabs();
  bindForms();
  const session = await api("/api/auth/me");
  if (session.authenticated) {
    state.csrfToken = session.csrfToken;
    showConsole();
    if (session.user?.mustChangePassword) {
      await selectTab("account");
    } else {
      await loadAll();
    }
  }
}

function bindTabs() {
  $$("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      await selectTab(button.dataset.tab);
    });
  });
}

async function selectTab(tabName) {
  const button = $(`[data-tab="${tabName}"]`);
  if (!button) {
    return;
  }

  state.activeTab = tabName;
  $$("[data-tab]").forEach((tab) => tab.classList.toggle("is-active", tab === button));
  $$("[data-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === state.activeTab);
  });

  sectionLabel.textContent = button.dataset.label || button.textContent.trim();
  sectionTitle.textContent = button.dataset.title || "Content management";
  sectionDescription.textContent = button.dataset.description || "";
  createButton.textContent = button.dataset.createLabel || "New item";
  createButton.hidden = tabName === "account";
  setWorkspaceMessage("");
  resetCurrentForm();
  await loadAll();
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
      if (result.user?.mustChangePassword) {
        await selectTab("account");
      } else {
        await loadAll();
      }
    } catch (error) {
      loginMessage.textContent = error.message;
    }
  });

  logoutButton.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.reload();
  });

  createButton.addEventListener("click", () => {
    resetCurrentForm();
    setWorkspaceMessage("Creating new content", "success");
  });
  $("[data-post-form]").addEventListener("submit", savePost);
  $("[data-page-form]").addEventListener("submit", savePage);
  $("[data-category-form]").addEventListener("submit", saveCategory);
  $("[data-media-form]").addEventListener("submit", saveMedia);
  $("[data-account-form]").addEventListener("submit", saveAccount);
  $("[data-delete-post]").addEventListener("click", () => removeResource("posts", $("[data-post-form]")));
  $("[data-delete-page]").addEventListener("click", () => removeResource("pages", $("[data-page-form]")));
  $("[data-delete-category]").addEventListener("click", () => removeResource("categories", $("[data-category-form]")));
}

function showConsole() {
  document.body.classList.add("is-authenticated");
  loginForm.hidden = true;
  loginForm.setAttribute("aria-hidden", "true");
  loginForm.reset();
  loginMessage.textContent = "";
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
    renderMediaList();
  }
  if (state.activeTab === "account") {
    state.account = (await api("/api/admin/account")).account;
    renderAccount();
  }
}

function renderList(type, items) {
  const list = $(`[data-${type}-list]`);
  list.replaceChildren();

  if (!items.length) {
    renderEmptyState(list, type);
    return;
  }

  for (const item of items) {
    const button = document.createElement("button");
    const title = escapeHtml(item.title || item.name || "Untitled");
    const slug = escapeHtml(item.slug || "");
    const meta = item.visibility
      ? `
        <span class="status-badge ${badgeClass("status", item.status)}">${statusLabel(item.status)}</span>
        <span class="visibility-badge ${badgeClass("visibility", item.visibility)}">${visibilityLabel(item.visibility)}</span>
      `
      : "";

    button.type = "button";
    button.className = "list-item";
    button.dataset.itemId = item.id || "";
    button.innerHTML = `
      <span class="item-title">${title}</span>
      ${slug ? `<span class="item-slug">${slug}</span>` : ""}
      ${meta ? `<span class="item-meta">${meta}</span>` : ""}
    `;
    button.addEventListener("click", () => {
      fillForm(type, item);
      setActiveListItem(type, item.id);
      setWorkspaceMessage("");
    });
    list.append(button);
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
  const type = singular(state.activeTab);
  const form = $(`[data-${type}-form]`);
  if (!form) {
    return;
  }
  form.reset();
  clearActiveListItem(type);
  if (form.elements.id) {
    form.elements.id.value = "";
  }
  if (form.elements.status) {
    form.elements.status.value = "draft";
  }
  if (form.elements.visibility) {
    form.elements.visibility.value = "private";
  }
  if (state.activeTab === "account" && state.account) {
    renderAccount();
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

async function saveMedia(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  delete body.id;

  try {
    await api("/api/admin/media", {
      method: "POST",
      body,
    });
    resetCurrentForm();
    await loadAll();
    setWorkspaceMessage("Media URL saved", "success");
  } catch (error) {
    setWorkspaceMessage(error.message, "error");
  }
}

async function saveAccount(event) {
  event.preventDefault();
  accountMessage.textContent = "";
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  if (body.newPassword !== body.confirmPassword) {
    accountMessage.textContent = "The new passwords do not match";
    return;
  }
  delete body.confirmPassword;

  try {
    const result = await api("/api/admin/account", {
      method: "PUT",
      body,
    });
    state.account = result.account;
    if (result.csrfToken) {
      state.csrfToken = result.csrfToken;
    }
    form.elements.currentPassword.value = "";
    form.elements.newPassword.value = "";
    form.elements.confirmPassword.value = "";
    accountMessage.textContent = "Account updated";
    setWorkspaceMessage("Account details updated", "success");
  } catch (error) {
    accountMessage.textContent = error.message;
  }
}

function renderAccount() {
  const form = $("[data-account-form]");
  form.elements.username.value = state.account?.username || "";
  form.elements.currentPassword.value = "";
  form.elements.newPassword.value = "";
  form.elements.confirmPassword.value = "";
  accountMessage.textContent = state.account?.mustChangePassword
    ? "Change the default password before continuing"
    : "";
}

function renderMediaList() {
  const list = $("[data-media-list]");
  list.replaceChildren();

  if (!state.media.length) {
    renderEmptyState(list, "media");
    return;
  }

  for (const item of state.media) {
    const button = document.createElement("button");
    const thumb = document.createElement("span");
    const details = document.createElement("span");
    const title = document.createElement("strong");
    const url = document.createElement("code");
    const meta = document.createElement("span");

    button.type = "button";
    button.className = "list-item media-list-item";
    button.dataset.itemId = item.id || "";
    thumb.className = "media-thumb";
    details.className = "media-details";
    title.textContent = item.filename || item.url || "Untitled";
    url.textContent = item.url || "";
    meta.textContent = [item.contentType, item.alt].filter(Boolean).join(" / ");

    if (item.url) {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = item.alt || item.filename || "";
      image.loading = "lazy";
      thumb.append(image);
    }

    details.append(title, url, meta);
    button.append(thumb, details);
    button.addEventListener("click", () => {
      fillForm("media", item);
      setActiveListItem("media", item.id);
      setWorkspaceMessage("");
    });
    list.append(button);
  }
}

async function saveResource(collection, form) {
  const body = Object.fromEntries(new FormData(form));
  const id = body.id;
  delete body.id;

  try {
    await api(id ? `/api/admin/${collection}/${encodeURIComponent(id)}` : `/api/admin/${collection}`, {
      method: id ? "PUT" : "POST",
      body,
    });
    resetCurrentForm();
    await loadAll();
    setWorkspaceMessage(`${collectionLabel(collection)} saved`, "success");
  } catch (error) {
    setWorkspaceMessage(error.message, "error");
  }
}

async function removeResource(collection, form) {
  const id = form.elements.id?.value;
  if (!id) {
    setWorkspaceMessage("Select an item to delete", "error");
    return;
  }
  if (!window.confirm(`Delete this ${collectionLabel(collection).toLowerCase()}?`)) {
    return;
  }

  try {
    await api(`/api/admin/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
    resetCurrentForm();
    await loadAll();
    setWorkspaceMessage(`${collectionLabel(collection)} deleted`, "success");
  } catch (error) {
    setWorkspaceMessage(error.message, "error");
  }
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

function renderEmptyState(list, type) {
  const copy = emptyStateCopy(type);
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.innerHTML = `
    <strong>${escapeHtml(copy.title)}</strong>
    <span>${escapeHtml(copy.description)}</span>
  `;
  list.append(empty);
}

function emptyStateCopy(type) {
  const copy = {
    post: ["No posts yet", "Create a post to save it as a private draft first."],
    page: ["No pages yet", "Standalone pages are private by default."],
    category: ["No categories yet", "Create categories to organize public post archives."],
    media: ["No media URLs yet", "Saved external image and media URLs will appear here."],
  };
  const [title, description] = copy[type] || ["No content yet", "Saved items will appear here."];
  return { title, description };
}

function setActiveListItem(type, id) {
  const list = $(`[data-${type}-list]`);
  if (!list) {
    return;
  }
  list.querySelectorAll(".list-item").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.itemId === String(id || ""));
  });
}

function clearActiveListItem(type) {
  const list = $(`[data-${type}-list]`);
  if (!list) {
    return;
  }
  list.querySelectorAll(".list-item").forEach((item) => item.classList.remove("is-active"));
}

function setWorkspaceMessage(text, tone = "") {
  workspaceMessage.textContent = text;
  workspaceMessage.classList.toggle("is-success", tone === "success");
  workspaceMessage.classList.toggle("is-error", tone === "error");
}

function collectionLabel(collection) {
  if (collection === "posts") return "Post";
  if (collection === "pages") return "Page";
  if (collection === "categories") return "Category";
  return "Content";
}

function statusLabel(status) {
  if (status === "published") return "Published";
  return "Draft";
}

function visibilityLabel(visibility) {
  if (visibility === "public") return "Public";
  return "Private";
}

function badgeClass(kind, value) {
  if (kind === "status" && value === "published") return "is-published";
  if (kind === "status") return "is-draft";
  if (kind === "visibility" && value === "public") return "is-public";
  return "is-private";
}

function singular(collection) {
  if (collection === "posts") return "post";
  if (collection === "pages") return "page";
  if (collection === "categories") return "category";
  if (collection === "media") return "media";
  if (collection === "account") return "account";
  return collection;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
