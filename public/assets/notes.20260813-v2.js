import {
  MIN_MASTER_PASSWORD_LENGTH,
  createPasswordVault,
  unlockPasswordVault,
} from "./password-vault-core.20260713.js";
import {
  decryptNote,
  encryptNote,
} from "./encrypted-notes-core.20260813.js";

const IDLE_LOCK_MS = 5 * 60 * 1000;
const HIDDEN_LOCK_MS = 60 * 1000;

const state = {
  csrfToken: "",
  vault: null,
  encryptedNotes: [],
  notes: [],
  dataKey: null,
  selectedId: "",
  dirtyId: "",
  saveTimer: 0,
  savePromise: null,
  idleTimer: 0,
  hiddenTimer: 0,
};

const elements = {
  loginShell: document.querySelector("[data-login-shell]"),
  loginForm: document.querySelector("[data-login-form]"),
  loginButton: document.querySelector("[data-login-button]"),
  loginMessage: document.querySelector("[data-login-message]"),
  appShell: document.querySelector("[data-app-shell]"),
  securityNotice: document.querySelector("[data-security-notice]"),
  vaultGate: document.querySelector("[data-vault-gate]"),
  vaultSetup: document.querySelector("[data-vault-setup]"),
  vaultSetupForm: document.querySelector("[data-vault-setup-form]"),
  vaultUnlock: document.querySelector("[data-vault-unlock]"),
  vaultUnlockForm: document.querySelector("[data-vault-unlock-form]"),
  vaultMessage: document.querySelector("[data-vault-message]"),
  notesLayout: document.querySelector("[data-notes-layout]"),
  lock: document.querySelector("[data-lock]"),
  logout: document.querySelector("[data-logout]"),
  newNote: document.querySelector("[data-new-note]"),
  emptyNew: document.querySelector("[data-empty-new]"),
  search: document.querySelector("[data-search]"),
  noteCount: document.querySelector("[data-note-count]"),
  searchSummary: document.querySelector("[data-search-summary]"),
  noteList: document.querySelector("[data-note-list]"),
  editorEmpty: document.querySelector("[data-editor-empty]"),
  noteForm: document.querySelector("[data-note-form]"),
  title: document.querySelector("[data-note-title]"),
  content: document.querySelector("[data-note-content]"),
  saveStatus: document.querySelector("[data-save-status]"),
  updatedAt: document.querySelector("[data-updated-at]"),
  characterCount: document.querySelector("[data-character-count]"),
  deleteNote: document.querySelector("[data-delete-note]"),
  mobileBack: document.querySelector("[data-mobile-back]"),
  globalMessage: document.querySelector("[data-global-message]"),
};

bindEvents();
void init();

function bindEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.vaultSetupForm.addEventListener("submit", handleVaultSetup);
  elements.vaultUnlockForm.addEventListener("submit", handleVaultUnlock);
  elements.lock.addEventListener("click", () => void lockWorkspace());
  elements.logout.addEventListener("click", handleLogout);
  elements.newNote.addEventListener("click", createNote);
  elements.emptyNew.addEventListener("click", createNote);
  elements.search.addEventListener("input", renderNoteList);
  elements.title.addEventListener("input", handleEditorInput);
  elements.content.addEventListener("input", handleEditorInput);
  elements.deleteNote.addEventListener("click", deleteSelectedNote);
  elements.mobileBack.addEventListener("click", async () => {
    await flushSave();
    elements.appShell.classList.remove("is-editing");
    elements.search.focus();
  });
  document.addEventListener("pointerdown", touchIdleTimer, { passive: true });
  document.addEventListener("keydown", touchIdleTimer);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", releasePlaintext);
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirtyId) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function init() {
  try {
    const session = await api("/api/auth/me");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    state.csrfToken = session.csrfToken || "";
    showWorkspace(session.user);
    await loadEncryptedWorkspace();
  } catch (error) {
    showLogin(error.message);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const formData = new FormData(elements.loginForm);
  const username = formData.get("username");
  const password = formData.get("password");
  elements.loginMessage.textContent = "";
  setFormBusy(elements.loginForm, true);
  elements.loginButton.textContent = "正在登录…";

  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: {
        username,
        password,
      },
    });
    state.csrfToken = result.csrfToken || "";
    elements.loginForm.reset();
    showWorkspace(result.user);
    await loadEncryptedWorkspace();
  } catch (error) {
    elements.loginMessage.textContent = loginErrorMessage(error);
  } finally {
    setFormBusy(elements.loginForm, false);
    elements.loginButton.textContent = "登录";
  }
}

async function handleLogout() {
  await lockWorkspace({ silent: true });
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    state.csrfToken = "";
    state.vault = null;
    state.encryptedNotes = [];
    showLogin();
  }
}

function showLogin(message = "") {
  releasePlaintext();
  elements.appShell.hidden = true;
  elements.loginShell.hidden = false;
  elements.loginMessage.textContent = message;
  elements.loginForm.elements.username.focus();
}

function showWorkspace(user) {
  elements.loginShell.hidden = true;
  elements.appShell.hidden = false;
  elements.securityNotice.hidden = !user?.mustChangePassword;
}

async function loadEncryptedWorkspace() {
  setVaultMessage("正在读取加密数据…");
  const [vaultResult, notesResult] = await Promise.all([
    api("/api/admin/password-vault"),
    api("/api/admin/encrypted-notes"),
  ]);
  state.vault = vaultResult.vault || null;
  state.encryptedNotes = Array.isArray(notesResult.notes) ? notesResult.notes : [];
  releasePlaintext();
  showVaultMode(state.vault ? "unlock" : "setup");
  setVaultMessage(
    state.vault
      ? "请输入保险箱主密码；解密只在当前浏览器中进行。"
      : "创建独立主密码后，笔记标题和正文才会以密文保存。",
  );
}

async function handleVaultSetup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  if (body.masterPassword !== body.confirmMasterPassword) {
    setVaultMessage("两次输入的主密码不一致。", "error");
    return;
  }
  setFormBusy(form, true);
  setVaultMessage("正在浏览器内创建加密密钥…");
  try {
    const created = await createPasswordVault(String(body.masterPassword || ""));
    const result = await api("/api/admin/password-vault", {
      method: "POST",
      body: created.vault,
    });
    state.vault = result.vault;
    state.dataKey = created.dataKey;
    state.encryptedNotes = [];
    state.notes = [];
    form.reset();
    openWorkspace();
    setGlobalMessage("主密码已创建。请将它离线保存在安全位置。", "success");
  } catch (error) {
    setVaultMessage(vaultErrorMessage(error), "error");
  } finally {
    setFormBusy(form, false);
  }
}

async function handleVaultUnlock(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const masterPassword = String(new FormData(form).get("masterPassword") || "");
  setFormBusy(form, true);
  setVaultMessage("正在本地解锁并验证密文…");
  try {
    const dataKey = await unlockPasswordVault(masterPassword, state.vault);
    const notes = await Promise.all(state.encryptedNotes.map(async (envelope) => ({
      envelope,
      data: await decryptNote(dataKey, envelope),
    })));
    state.dataKey = dataKey;
    state.notes = notes;
    form.reset();
    openWorkspace();
  } catch {
    releasePlaintext();
    showVaultMode("unlock");
    setVaultMessage("无法解锁。请检查主密码以及加密数据是否完整。", "error");
  } finally {
    setFormBusy(form, false);
  }
}

function openWorkspace() {
  elements.vaultGate.hidden = true;
  elements.notesLayout.hidden = false;
  elements.lock.hidden = false;
  elements.search.value = "";
  renderNoteList();
  if (state.notes.length > 0) {
    void selectNote(state.notes[0].envelope.id, { focus: false });
  } else {
    showEmptyEditor();
  }
  touchIdleTimer();
}

async function lockWorkspace({ silent = false } = {}) {
  await flushSave();
  releasePlaintext();
  if (state.vault) {
    showVaultMode("unlock");
    if (!silent) setVaultMessage("工作区已锁定，内存中的解密密钥与明文已释放。", "success");
  }
}

function releasePlaintext() {
  window.clearTimeout(state.idleTimer);
  window.clearTimeout(state.hiddenTimer);
  window.clearTimeout(state.saveTimer);
  state.idleTimer = 0;
  state.hiddenTimer = 0;
  state.saveTimer = 0;
  state.dataKey = null;
  state.notes = [];
  state.selectedId = "";
  state.dirtyId = "";
  state.savePromise = null;
  elements.title.value = "";
  elements.content.value = "";
  elements.noteList.replaceChildren();
  elements.noteForm.hidden = true;
  elements.notesLayout.hidden = true;
  elements.lock.hidden = true;
  elements.appShell.classList.remove("is-editing");
}

function showVaultMode(mode) {
  elements.vaultGate.hidden = false;
  elements.vaultSetup.hidden = mode !== "setup";
  elements.vaultUnlock.hidden = mode !== "unlock";
  elements.notesLayout.hidden = true;
  elements.lock.hidden = true;
  const form = mode === "setup" ? elements.vaultSetupForm : elements.vaultUnlockForm;
  window.setTimeout(() => form.querySelector("input")?.focus(), 0);
}

async function createNote() {
  if (!state.dataKey) return;
  elements.newNote.disabled = true;
  elements.emptyNew.disabled = true;
  setGlobalMessage("");
  await flushSave();
  try {
    const id = crypto.randomUUID();
    const data = { title: "无标题笔记", content: "" };
    const encrypted = await encryptNote(state.dataKey, id, data);
    const result = await api("/api/admin/encrypted-notes", {
      method: "POST",
      body: encrypted,
    });
    const item = { envelope: result.note, data };
    state.encryptedNotes.unshift(result.note);
    state.notes.unshift(item);
    elements.search.value = "";
    renderNoteList();
    await selectNote(id);
    elements.title.select();
  } catch (error) {
    setGlobalMessage(`无法新建笔记：${error.message}`);
  } finally {
    elements.newNote.disabled = false;
    elements.emptyNew.disabled = false;
  }
}

async function selectNote(id, options = {}) {
  if (state.selectedId !== id) await flushSave();
  const item = state.notes.find(({ envelope }) => envelope.id === id);
  if (!item) return;

  state.selectedId = id;
  elements.editorEmpty.hidden = true;
  elements.noteForm.hidden = false;
  elements.title.value = item.data.title || "";
  elements.content.value = item.data.content || "";
  updateEditorMeta(item);
  setSaveStatus("已加密保存", "saved");
  renderNoteList();
  elements.appShell.classList.add("is-editing");
  if (options.focus !== false) elements.content.focus();
}

function showEmptyEditor() {
  state.selectedId = "";
  elements.noteForm.hidden = true;
  elements.editorEmpty.hidden = false;
  elements.appShell.classList.remove("is-editing");
}

function handleEditorInput() {
  const item = selectedNote();
  if (!item) return;
  item.data.title = elements.title.value;
  item.data.content = elements.content.value;
  state.dirtyId = item.envelope.id;
  updateEditorMeta(item);
  renderNoteList();
  setSaveStatus("等待加密保存", "saving");
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => void flushSave(), 700);
  touchIdleTimer();
}

async function flushSave() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (state.savePromise) await state.savePromise;
  const item = state.notes.find(({ envelope }) => envelope.id === state.dirtyId);
  if (!item || !state.dataKey) return;

  const id = item.envelope.id;
  const snapshot = { title: item.data.title, content: item.data.content };
  state.dirtyId = "";
  setSaveStatus("正在本地加密并保存…", "saving");

  state.savePromise = (async () => {
    const encrypted = await encryptNote(state.dataKey, id, snapshot);
    return await api(`/api/admin/encrypted-notes/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: encrypted,
    });
  })();

  try {
    const result = await state.savePromise;
    item.envelope = result.note;
    const encryptedIndex = state.encryptedNotes.findIndex((note) => note.id === id);
    if (encryptedIndex >= 0) state.encryptedNotes.splice(encryptedIndex, 1, result.note);
    if (!item.data.title.trim()) {
      item.data.title = snapshot.title.trim() || "无标题笔记";
      if (state.selectedId === id) elements.title.value = item.data.title;
    }
    if (state.selectedId === id && state.dirtyId !== id) {
      updateEditorMeta(item);
      setSaveStatus("已加密保存", "saved");
    }
    renderNoteList();
  } catch (error) {
    if (state.dataKey) state.dirtyId = id;
    setSaveStatus("保存失败，请继续编辑后重试", "error");
    setGlobalMessage(`保存失败：${error.message}`);
  } finally {
    state.savePromise = null;
    if (state.dirtyId === id && state.dataKey) {
      state.saveTimer = window.setTimeout(() => void flushSave(), 1600);
    }
  }
}

async function deleteSelectedNote() {
  const item = selectedNote();
  if (!item) return;
  const title = item.data.title.trim() || "无标题笔记";
  if (!window.confirm(`确定删除“${title}”吗？此操作无法撤销。`)) return;

  window.clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  if (state.dirtyId === item.envelope.id) state.dirtyId = "";
  elements.deleteNote.disabled = true;
  try {
    await api(`/api/admin/encrypted-notes/${encodeURIComponent(item.envelope.id)}`, {
      method: "DELETE",
    });
    state.notes = state.notes.filter(({ envelope }) => envelope.id !== item.envelope.id);
    state.encryptedNotes = state.encryptedNotes.filter((note) => note.id !== item.envelope.id);
    renderNoteList();
    if (state.notes.length > 0) {
      await selectNote(state.notes[0].envelope.id, { focus: false });
    } else {
      showEmptyEditor();
    }
  } catch (error) {
    setGlobalMessage(`删除失败：${error.message}`);
  } finally {
    elements.deleteNote.disabled = false;
  }
}

function renderNoteList() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const filtered = query
    ? state.notes.filter(({ data }) => `${data.title}\n${data.content}`.toLocaleLowerCase().includes(query))
    : state.notes;

  elements.noteList.replaceChildren();
  elements.noteCount.textContent = `${state.notes.length} 条笔记`;
  elements.searchSummary.textContent = query ? `找到 ${filtered.length} 条` : "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    strong.textContent = query ? "没有匹配的笔记" : "还没有笔记";
    span.textContent = query ? "试试更短的关键词" : "点击“新建”开始记录";
    empty.append(strong, span);
    elements.noteList.append(empty);
    return;
  }

  for (const item of filtered) {
    const { envelope, data } = item;
    const button = document.createElement("button");
    const title = document.createElement("strong");
    const excerpt = document.createElement("span");
    const time = document.createElement("time");
    button.type = "button";
    button.className = "note-list-item";
    button.classList.toggle("is-active", envelope.id === state.selectedId);
    button.setAttribute("aria-pressed", String(envelope.id === state.selectedId));
    title.textContent = data.title.trim() || "无标题笔记";
    excerpt.textContent = data.content.trim().replace(/\s+/g, " ") || "暂无正文";
    time.dateTime = envelope.updatedAt || envelope.createdAt || "";
    time.textContent = formatDate(envelope.updatedAt || envelope.createdAt);
    button.append(title, excerpt, time);
    button.addEventListener("click", () => void selectNote(envelope.id));
    elements.noteList.append(button);
  }
}

function updateEditorMeta(item) {
  elements.updatedAt.textContent = item?.envelope?.updatedAt
    ? `更新于 ${formatDate(item.envelope.updatedAt, true)}`
    : "新建笔记";
  elements.characterCount.textContent = `${elements.content.value.length} 个字`;
}

function selectedNote() {
  return state.notes.find(({ envelope }) => envelope.id === state.selectedId) || null;
}

function touchIdleTimer() {
  if (!state.dataKey) return;
  window.clearTimeout(state.idleTimer);
  state.idleTimer = window.setTimeout(() => void lockWorkspace(), IDLE_LOCK_MS);
}

function handleVisibilityChange() {
  window.clearTimeout(state.hiddenTimer);
  state.hiddenTimer = 0;
  if (document.hidden && state.dataKey) {
    state.hiddenTimer = window.setTimeout(() => void lockWorkspace(), HIDDEN_LOCK_MS);
  } else {
    touchIdleTimer();
  }
}

function setSaveStatus(text, tone = "") {
  elements.saveStatus.textContent = text;
  elements.saveStatus.dataset.tone = tone;
}

function setVaultMessage(text, tone = "") {
  elements.vaultMessage.textContent = text;
  elements.vaultMessage.dataset.tone = tone;
}

function setGlobalMessage(text, tone = "") {
  elements.globalMessage.textContent = text;
  elements.globalMessage.dataset.tone = tone;
}

function setFormBusy(form, busy) {
  form.querySelectorAll("button, input").forEach((control) => {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === "true";
      delete control.dataset.wasDisabled;
    }
  });
}

function formatDate(value, includeTime = false) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" }
  ).format(date);
}

function loginErrorMessage(error) {
  if (error.status === 401) return "用户名或密码不正确。";
  if (error.status === 429) return "登录尝试过多，请稍后再试。";
  return error.message || "暂时无法登录。";
}

function vaultErrorMessage(error) {
  if (String(error.message).includes(String(MIN_MASTER_PASSWORD_LENGTH))) {
    return `主密码至少需要 ${MIN_MASTER_PASSWORD_LENGTH} 个字符。`;
  }
  return error.message || "无法创建加密空间。";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method) && state.csrfToken) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "请求失败，请稍后重试。");
    error.status = response.status;
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      showLogin("登录已过期，请重新登录。");
    }
    throw error;
  }
  return body;
}
