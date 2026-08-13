import {
  buildPasswordPools,
  estimatePasswordStrength,
  generatePasswords,
} from "./password-tool-core.20260710.js";

const app = document.querySelector("[data-password-tool]");

if (app) {
  const form = app.querySelector("[data-password-form]");
  const results = app.querySelector("[data-password-results]");
  const copyAllButton = app.querySelector("[data-copy-all]");
  const errorMessage = app.querySelector("[data-password-error]");
  const strength = app.querySelector("[data-password-strength]");
  const excludeToggle = app.querySelector("[data-password-exclude-enabled]");
  const excludedInput = app.querySelector("[data-password-excluded]");
  const announcement = app.querySelector("[data-password-announcement]");
  let currentPasswords = [];

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

  function announce(message) {
    announcement.textContent = "";
    window.setTimeout(() => {
      announcement.textContent = message;
    }, 20);
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

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      currentPasswords = generatePasswords(getOptions());
      renderResults(currentPasswords);
      errorMessage.hidden = true;
      announce(`Generated ${currentPasswords.length} ${currentPasswords.length === 1 ? "password" : "passwords"} locally.`);
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
    announce(copied ? "All passwords copied to the clipboard." : "Copy each password individually.");
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
  renderStrength();
}
