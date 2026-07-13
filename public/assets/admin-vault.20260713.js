import { generatePasswords } from "./password-tool-core.20260710.js";
import {
  MIN_MASTER_PASSWORD_LENGTH,
  changePasswordVaultMasterPassword,
  createPasswordVault,
  decryptPasswordVaultEntry,
  encryptPasswordVaultEntry,
  unlockPasswordVault,
} from "./password-vault-core.20260713.js";

const IDLE_LOCK_MS = 5 * 60 * 1000;
const HIDDEN_LOCK_MS = 60 * 1000;

function initPasswordVault() {
  const root = document.querySelector("[data-password-vault]");
  if (!root) return;

  const elements = {
    setup: root.querySelector("[data-vault-setup]"),
    setupForm: root.querySelector("[data-vault-setup-form]"),
    locked: root.querySelector("[data-vault-locked]"),
    unlockForm: root.querySelector("[data-vault-unlock-form]"),
    unlocked: root.querySelector("[data-vault-unlocked]"),
    message: root.querySelector("[data-vault-message]"),
    entryForm: root.querySelector("[data-vault-entry-form]"),
    entryList: root.querySelector("[data-vault-entry-list]"),
    entryCount: root.querySelector("[data-vault-entry-count]"),
    search: root.querySelector("[data-vault-search]"),
    lockButton: root.querySelector("[data-vault-lock]"),
    newButton: root.querySelector("[data-vault-new]"),
    deleteButton: root.querySelector("[data-vault-delete]"),
    generateButton: root.querySelector("[data-vault-generate]"),
    copyButton: root.querySelector("[data-vault-copy-password]"),
    revealButton: root.querySelector("[data-vault-reveal-password]"),
    exportButton: root.querySelector("[data-vault-export]"),
    changeForm: root.querySelector("[data-vault-change-form]"),
  };
  const state = {
    csrfToken: "",
    vault: null,
    encryptedEntries: [],
    entries: [],
    dataKey: null,
    idleTimer: null,
    hiddenTimer: null,
    loading: false,
  };

  bindEvents();
  void openVaultFromHashWhenReady();

  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.dataset.tab === "vault") {
          document.querySelector("[data-create]").hidden = true;
          void loadVault();
        } else {
          lockVault({ silent: true });
        }
      });
    });

    document.querySelector("[data-logout]")?.addEventListener("click", () => {
      lockVault({ silent: true });
    });
    document.querySelector("[data-login]")?.addEventListener("submit", () => {
      window.setTimeout(() => void openVaultFromHashWhenReady(), 350);
    });
    window.addEventListener("hashchange", () => void openVaultFromHashWhenReady());
    window.addEventListener("pagehide", () => lockVault({ silent: true }));
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("pointerdown", touchIdleTimer, { passive: true });
    document.addEventListener("keydown", touchIdleTimer);

    elements.setupForm.addEventListener("submit", handleSetup);
    elements.unlockForm.addEventListener("submit", handleUnlock);
    elements.entryForm.addEventListener("submit", handleEntrySave);
    elements.changeForm.addEventListener("submit", handleMasterPasswordChange);
    elements.search.addEventListener("input", renderEntries);
    elements.lockButton.addEventListener("click", () => lockVault());
    elements.newButton.addEventListener("click", resetEntryForm);
    elements.deleteButton.addEventListener("click", handleEntryDelete);
    elements.generateButton.addEventListener("click", generateEntryPassword);
    elements.copyButton.addEventListener("click", copyEntryPassword);
    elements.revealButton.addEventListener("click", togglePasswordVisibility);
    elements.exportButton.addEventListener("click", exportEncryptedBackup);
  }

  async function openVaultFromHashWhenReady(attempt = 0) {
    if (window.location.hash !== "#vault") return;
    try {
      const session = await refreshSession();
      if (session.authenticated && !session.user?.mustChangePassword) {
        document.querySelector('[data-tab="vault"]')?.click();
        return;
      }
    } catch {
      // The regular admin login surface handles authentication errors.
    }
    if (attempt < 5) {
      window.setTimeout(() => void openVaultFromHashWhenReady(attempt + 1), 350);
    }
  }

  async function refreshSession() {
    const response = await fetch("/api/auth/me", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not verify the administrator session.");
    state.csrfToken = body.csrfToken || "";
    return body;
  }

  async function vaultApi(path, options = {}) {
    const method = options.method || "GET";
    if (!["GET", "HEAD"].includes(method)) {
      const session = await refreshSession();
      if (!session.authenticated) throw new Error("Administrator session expired. Sign in again.");
    }
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body) headers.set("Content-Type", "application/json");
    if (!["GET", "HEAD"].includes(method)) headers.set("X-CSRF-Token", state.csrfToken);
    const response = await fetch(path, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) lockVault({ silent: true });
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return body;
  }

  async function loadVault() {
    if (state.loading) return;
    state.loading = true;
    setMessage("Loading encrypted vault…");
    try {
      const session = await refreshSession();
      if (!session.authenticated) throw new Error("Administrator session expired. Sign in again.");
      const result = await vaultApi("/api/admin/password-vault");
      state.vault = result.vault || null;
      state.encryptedEntries = Array.isArray(result.entries) ? result.entries : [];
      lockVault({ silent: true, preserveMessage: true });
      showMode(state.vault ? "locked" : "setup");
      setMessage(
        state.vault
          ? "Enter your vault master password. It never leaves this browser."
          : "Create a separate master password to protect encrypted vault data.",
      );
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      state.loading = false;
    }
  }

  async function handleSetup(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (body.masterPassword !== body.confirmMasterPassword) {
      setMessage("Master passwords do not match.", "error");
      return;
    }
    setFormBusy(form, true);
    setMessage("Creating encrypted vault…");
    try {
      const created = await createPasswordVault(body.masterPassword);
      const result = await vaultApi("/api/admin/password-vault", {
        method: "POST",
        body: created.vault,
      });
      state.vault = result.vault;
      state.dataKey = created.dataKey;
      state.encryptedEntries = [];
      state.entries = [];
      form.reset();
      showMode("unlocked");
      resetEntryForm();
      renderEntries();
      touchIdleTimer();
      setMessage("Vault created and unlocked. Keep the master password in a safe offline place.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      setFormBusy(form, false);
    }
  }

  async function handleUnlock(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const masterPassword = new FormData(form).get("masterPassword");
    setFormBusy(form, true);
    setMessage("Unlocking locally…");
    try {
      const dataKey = await unlockPasswordVault(String(masterPassword || ""), state.vault);
      const decrypted = await Promise.all(state.encryptedEntries.map(async (envelope) => ({
        envelope,
        data: await decryptPasswordVaultEntry(dataKey, envelope),
      })));
      state.dataKey = dataKey;
      state.entries = decrypted;
      form.reset();
      showMode("unlocked");
      resetEntryForm();
      renderEntries();
      touchIdleTimer();
      setMessage(`Vault unlocked. ${state.entries.length} encrypted ${state.entries.length === 1 ? "entry" : "entries"} loaded.`, "success");
    } catch {
      state.dataKey = null;
      state.entries = [];
      setMessage("Could not unlock the vault. Check the master password and encrypted data.", "error");
    } finally {
      setFormBusy(form, false);
    }
  }

  async function handleEntrySave(event) {
    event.preventDefault();
    if (!state.dataKey) {
      setMessage("Unlock the vault before saving an entry.", "error");
      return;
    }
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const existingId = String(body.id || "");
    const id = existingId || crypto.randomUUID();
    delete body.id;
    setFormBusy(form, true);
    try {
      const encrypted = await encryptPasswordVaultEntry(state.dataKey, id, body);
      const result = await vaultApi(
        existingId
          ? `/api/admin/password-vault/entries/${encodeURIComponent(id)}`
          : "/api/admin/password-vault/entries",
        { method: existingId ? "PUT" : "POST", body: encrypted },
      );
      const decryptedItem = { envelope: result.entry, data: body };
      const index = state.entries.findIndex((item) => item.envelope.id === id);
      if (index >= 0) {
        state.entries.splice(index, 1, decryptedItem);
        const encryptedIndex = state.encryptedEntries.findIndex((item) => item.id === id);
        state.encryptedEntries.splice(encryptedIndex, 1, result.entry);
      } else {
        state.entries.unshift(decryptedItem);
        state.encryptedEntries.unshift(result.entry);
      }
      resetEntryForm();
      renderEntries();
      touchIdleTimer();
      setMessage("Password entry encrypted in this browser and saved.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      setFormBusy(form, false);
    }
  }

  async function handleEntryDelete() {
    const id = elements.entryForm.elements.id.value;
    if (!id) {
      setMessage("Select an entry to delete.", "error");
      return;
    }
    if (!window.confirm("Delete this encrypted password entry? This cannot be undone.")) return;
    try {
      await vaultApi(`/api/admin/password-vault/entries/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      state.entries = state.entries.filter((item) => item.envelope.id !== id);
      state.encryptedEntries = state.encryptedEntries.filter((item) => item.id !== id);
      resetEntryForm();
      renderEntries();
      setMessage("Encrypted password entry deleted.", "success");
    } catch (error) {
      setMessage(error.message, "error");
    }
  }

  async function handleMasterPasswordChange(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    if (body.newMasterPassword !== body.confirmMasterPassword) {
      setMessage("New master passwords do not match.", "error");
      return;
    }
    setFormBusy(form, true);
    setMessage("Rewrapping the vault key…");
    try {
      const changedVault = await changePasswordVaultMasterPassword(
        body.currentMasterPassword,
        body.newMasterPassword,
        state.vault,
      );
      const result = await vaultApi("/api/admin/password-vault", {
        method: "PUT",
        body: changedVault,
      });
      state.vault = result.vault;
      form.reset();
      form.closest("details").open = false;
      touchIdleTimer();
      setMessage("Master password changed. Existing entries did not need to be re-encrypted.", "success");
    } catch {
      setMessage("Could not change the master password. Check the current password.", "error");
    } finally {
      setFormBusy(form, false);
    }
  }

  function renderEntries() {
    const query = elements.search.value.trim().toLocaleLowerCase();
    const visible = state.entries.filter(({ data }) => (
      [data.title, data.username, data.url]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query))
    ));
    elements.entryList.replaceChildren();
    elements.entryCount.textContent = `${visible.length} of ${state.entries.length}`;

    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      const description = document.createElement("span");
      title.textContent = query ? "No matching entries" : "No saved passwords yet";
      description.textContent = query
        ? "Try a different site, username, or URL."
        : "Create an entry; encryption happens before it is sent to D1.";
      empty.append(title, description);
      elements.entryList.append(empty);
      return;
    }

    visible.forEach(({ envelope, data }) => {
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const username = document.createElement("span");
      const secret = document.createElement("code");
      button.type = "button";
      button.className = "vault-list-item";
      button.dataset.itemId = envelope.id;
      title.textContent = data.title;
      username.textContent = data.username || data.url || "No username";
      secret.textContent = "••••••••••••";
      button.append(title, username, secret);
      button.addEventListener("click", () => selectEntry(envelope.id));
      elements.entryList.append(button);
    });
  }

  function selectEntry(id) {
    const item = state.entries.find((entry) => entry.envelope.id === id);
    if (!item) return;
    elements.entryForm.elements.id.value = id;
    for (const [name, value] of Object.entries(item.data)) {
      if (elements.entryForm.elements[name]) elements.entryForm.elements[name].value = value || "";
    }
    elements.deleteButton.disabled = false;
    elements.entryList.querySelectorAll(".vault-list-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.itemId === id);
    });
    setMessage(`Editing ${item.data.title}.`);
    touchIdleTimer();
  }

  function resetEntryForm() {
    elements.entryForm.reset();
    elements.entryForm.elements.id.value = "";
    elements.entryForm.elements.password.type = "password";
    elements.revealButton.textContent = "Show";
    elements.revealButton.setAttribute("aria-pressed", "false");
    elements.deleteButton.disabled = true;
    elements.entryList.querySelectorAll(".vault-list-item").forEach((button) => {
      button.classList.remove("is-active");
    });
  }

  function generateEntryPassword() {
    if (!state.dataKey) return;
    const [password] = generatePasswords({
      lowercase: true,
      uppercase: true,
      numbers: true,
      symbols: true,
      excludeEnabled: true,
      excluded: "O0Il1|`'\"",
      length: 24,
      count: 1,
    });
    elements.entryForm.elements.password.value = password;
    setMessage("Generated a 24-character password locally. Save the entry to encrypt it.", "success");
    touchIdleTimer();
  }

  async function copyEntryPassword() {
    const password = elements.entryForm.elements.password.value;
    if (!password) {
      setMessage("There is no password to copy.", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(password);
      setMessage("Password copied. Clear the clipboard after use on shared devices.", "success");
    } catch {
      setMessage("Clipboard access failed. Select and copy the password manually.", "error");
    }
    touchIdleTimer();
  }

  function togglePasswordVisibility() {
    const input = elements.entryForm.elements.password;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    elements.revealButton.textContent = show ? "Hide" : "Show";
    elements.revealButton.setAttribute("aria-pressed", String(show));
    touchIdleTimer();
  }

  function exportEncryptedBackup() {
    if (!state.vault) return;
    const backup = {
      format: "ai-build-lab-password-vault",
      version: 1,
      exportedAt: new Date().toISOString(),
      vault: state.vault,
      entries: state.encryptedEntries,
    };
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-build-lab-password-vault-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage("Encrypted backup exported. It still requires the master password.", "success");
    touchIdleTimer();
  }

  function showMode(mode) {
    elements.setup.hidden = mode !== "setup";
    elements.locked.hidden = mode !== "locked";
    elements.unlocked.hidden = mode !== "unlocked";
  }

  function lockVault({ silent = false, preserveMessage = false } = {}) {
    window.clearTimeout(state.idleTimer);
    window.clearTimeout(state.hiddenTimer);
    state.idleTimer = null;
    state.hiddenTimer = null;
    state.dataKey = null;
    state.entries = [];
    elements.unlockForm.reset();
    elements.search.value = "";
    resetEntryForm();
    elements.entryList.replaceChildren();
    elements.entryCount.textContent = "0 of 0";
    if (state.vault) showMode("locked");
    if (!silent && !preserveMessage) setMessage("Vault locked and the in-memory key was released.", "success");
  }

  function touchIdleTimer() {
    if (!state.dataKey) return;
    window.clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      lockVault({ silent: true });
      setMessage("Vault locked after five minutes of inactivity.", "success");
    }, IDLE_LOCK_MS);
  }

  function handleVisibilityChange() {
    window.clearTimeout(state.hiddenTimer);
    state.hiddenTimer = null;
    if (document.hidden && state.dataKey) {
      state.hiddenTimer = window.setTimeout(() => {
        lockVault({ silent: true });
        setMessage("Vault locked while the page was in the background.", "success");
      }, HIDDEN_LOCK_MS);
    } else {
      touchIdleTimer();
    }
  }

  function setFormBusy(form, busy) {
    form.querySelectorAll("button, input, textarea").forEach((control) => {
      if (busy) {
        control.dataset.vaultWasDisabled = String(control.disabled);
        control.disabled = true;
      } else {
        control.disabled = control.dataset.vaultWasDisabled === "true";
        delete control.dataset.vaultWasDisabled;
      }
    });
  }

  function setMessage(message, tone = "") {
    elements.message.textContent = message;
    elements.message.classList.toggle("is-success", tone === "success");
    elements.message.classList.toggle("is-error", tone === "error");
  }
}

export { initPasswordVault };
