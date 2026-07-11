import {
  buildPasswordPools,
  estimatePasswordStrength,
  generatePasswords,
} from "./password-tool-core.20260710.js";

const HISTORY_KEY = "ai-build-lab.password-history.v1";
const HISTORY_LIMIT = 20;
const app = document.querySelector("[data-password-tool]");

if (app) {
  const form = app.querySelector("[data-password-form]");
  const results = app.querySelector("[data-password-results]");
  const copyAllButton = app.querySelector("[data-copy-all]");
  const errorMessage = app.querySelector("[data-password-error]");
  const strength = app.querySelector("[data-password-strength]");
  const excludeToggle = app.querySelector("[data-password-exclude-enabled]");
  const excludedInput = app.querySelector("[data-password-excluded]");
  const historyToggle = app.querySelector("[data-password-history-enabled]");
  const historyList = app.querySelector("[data-history-list]");
  const historyCount = app.querySelector("[data-history-count]");
  const clearHistoryButton = app.querySelector("[data-clear-history]");
  const announcement = app.querySelector("[data-password-announcement]");
  let currentPasswords = [];
  let clearConfirmationTimer = null;

  function getOptions() {
    return {
      lowercase: app.querySelector('[data-character="lowercase"]').checked,
      uppercase: app.querySelector('[data-character="uppercase"]').checked,
      numbers: app.querySelector('[data-character="numbers"]').checked,
      symbols: app.querySelector('[data-character="symbols"]').checked,
      excludeEnabled: excludeToggle.checked,
      excluded: excludedInput.value,
      length: Number(app.querySelector("[data-password-length]").value),
      count: Number(app.querySelector("[data-password-count]").value),
    };
  }

  function readHistory() {
    try {
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(stored) ? stored.filter((entry) => (
        entry && Array.isArray(entry.passwords) && typeof entry.createdAt === "string"
      )).slice(0, HISTORY_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function writeHistory(entries) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
    } catch {
      announce("The browser could not save password history. Check your storage permissions.");
    }
  }

  function announce(message) {
    announcement.textContent = "";
    window.setTimeout(() => {
      announcement.textContent = message;
    }, 20);
  }

  function createCopyButton(password, label = "Copy") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      const copied = await copyText(password);
      const original = button.textContent;
      button.textContent = copied ? "Copied" : "Copy failed";
      announce(copied ? "Password copied to the clipboard." : "Copy failed. Select the password manually.");
      window.setTimeout(() => {
        button.textContent = original;
      }, 1600);
    });
    return button;
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("readonly", "");
      fallback.className = "clipboard-fallback";
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      return copied;
    }
  }

  function renderResults(passwords) {
    results.replaceChildren();
    const list = document.createElement("ol");
    list.className = "password-list";

    passwords.forEach((password, index) => {
      const item = document.createElement("li");
      const number = document.createElement("span");
      const code = document.createElement("code");
      number.className = "result-number";
      number.textContent = String(index + 1).padStart(2, "0");
      code.textContent = password;
      item.append(number, code, createCopyButton(password));
      list.append(item);
    });

    results.append(list);
    copyAllButton.hidden = passwords.length === 0;
  }

  function renderStrength() {
    try {
      const options = getOptions();
      buildPasswordPools(options);
      const estimate = estimatePasswordStrength(options);
      strength.dataset.level = estimate.level;
      strength.querySelector("strong").textContent = estimate.label;
      strength.querySelector("small").textContent = `About ${estimate.bits} bits`;
      strength.classList.remove("is-unavailable");
      errorMessage.hidden = true;
    } catch (error) {
      strength.dataset.level = "weak";
      strength.querySelector("strong").textContent = "Unavailable";
      strength.querySelector("small").textContent = "Adjust the character settings";
      strength.classList.add("is-unavailable");
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
    }
  }

  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function renderHistory() {
    const entries = readHistory();
    const passwordTotal = entries.reduce((total, entry) => total + entry.passwords.length, 0);
    historyCount.textContent = passwordTotal ? `${passwordTotal} ${passwordTotal === 1 ? "password" : "passwords"}` : "No saved passwords";
    clearHistoryButton.disabled = entries.length === 0;
    historyList.replaceChildren();

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "Enable password history to keep newly generated passwords here.";
      historyList.append(empty);
      return;
    }

    entries.forEach((entry) => {
      const batch = document.createElement("article");
      const header = document.createElement("div");
      const time = document.createElement("time");
      const list = document.createElement("ul");
      batch.className = "history-batch";
      header.className = "history-batch-heading";
      time.dateTime = entry.createdAt;
      time.textContent = formatTimestamp(entry.createdAt);
      header.append(time);
      list.className = "history-passwords";

      entry.passwords.forEach((password) => {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = password;
        item.append(code, createCopyButton(password, "Copy"));
        list.append(item);
      });

      batch.append(header, list);
      historyList.append(batch);
    });
  }

  function recordPasswords(passwords) {
    const entries = readHistory();
    entries.unshift({
      createdAt: new Date().toISOString(),
      passwords,
    });
    writeHistory(entries);
    renderHistory();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      currentPasswords = generatePasswords(getOptions());
      renderResults(currentPasswords);
      errorMessage.hidden = true;
      if (historyToggle.checked) recordPasswords(currentPasswords);
      announce(`Generated ${currentPasswords.length} ${currentPasswords.length === 1 ? "password" : "passwords"}.`);
    } catch (error) {
      currentPasswords = [];
      copyAllButton.hidden = true;
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
      errorMessage.focus?.();
      announce(error.message);
    }
  });

  copyAllButton.addEventListener("click", async () => {
    const copied = await copyText(currentPasswords.join("\n"));
    const original = copyAllButton.textContent;
    copyAllButton.textContent = copied ? "Copied" : "Copy failed";
    announce(copied ? "All passwords copied to the clipboard." : "Copy failed. Copy each password individually.");
    window.setTimeout(() => {
      copyAllButton.textContent = original;
    }, 1600);
  });

  excludeToggle.addEventListener("change", () => {
    excludedInput.disabled = !excludeToggle.checked;
    renderStrength();
  });

  form.addEventListener("input", renderStrength);
  form.addEventListener("change", renderStrength);

  clearHistoryButton.addEventListener("click", () => {
    if (clearHistoryButton.dataset.confirm !== "true") {
      clearHistoryButton.dataset.confirm = "true";
      clearHistoryButton.textContent = "Select again to confirm";
      clearConfirmationTimer = window.setTimeout(() => {
        clearHistoryButton.dataset.confirm = "false";
        clearHistoryButton.textContent = "Clear history";
      }, 3000);
      return;
    }

    window.clearTimeout(clearConfirmationTimer);
    localStorage.removeItem(HISTORY_KEY);
    clearHistoryButton.dataset.confirm = "false";
    clearHistoryButton.textContent = "Clear history";
    renderHistory();
    announce("Password history cleared.");
  });

  renderStrength();
  renderHistory();
}
