import {
  formatJson,
  minifyJson,
  parseJson,
  toTreeNodes,
} from "./json-tool-core.20260706.js";

const sampleJson = {
  name: "AI Build Lab",
  url: "https://superstar1014.qzz.io/",
  features: ["format", "minify", "tree view", "copy"],
  private: true,
  nested: {
    owner: "local browser",
    uploaded: false,
  },
};

const workbench = document.querySelector("[data-json-tool]");

if (workbench) {
  initializeJsonTool(workbench);
}

function initializeJsonTool(root) {
  const input = root.querySelector("#json-input");
  const output = root.querySelector("[data-json-output]");
  const tree = root.querySelector("[data-json-tree]");
  const status = root.querySelector("[data-json-status]");
  let latestOutput = "";

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-json-action]");
    if (!button) return;

    const action = button.dataset.jsonAction;
    if (action === "sample") {
      input.value = JSON.stringify(sampleJson);
      applyResult(formatJson(input.value), { input, output, tree, status });
      latestOutput = output.textContent;
      return;
    }

    if (action === "clear") {
      input.value = "";
      latestOutput = "";
      output.textContent = "Formatted JSON will appear here.";
      tree.innerHTML = "";
      setStatus(status, "Waiting for input");
      return;
    }

    if (action === "format") {
      const result = formatJson(input.value);
      applyResult(result, { input, output, tree, status });
      latestOutput = result.ok ? result.value : "";
      return;
    }

    if (action === "minify") {
      const result = minifyJson(input.value);
      applyResult(result, { input, output, tree, status });
      latestOutput = result.ok ? result.value : "";
      return;
    }

    if (action === "copy") {
      await copyOutput(latestOutput || output.textContent, status);
    }
  });

  input.addEventListener("input", () => {
    if (!input.value.trim()) {
      latestOutput = "";
      output.textContent = "Formatted JSON will appear here.";
      tree.innerHTML = "";
      setStatus(status, "Waiting for input");
      return;
    }

    const result = parseJson(input.value);
    if (result.ok) {
      setStatus(status, "Valid JSON");
    }
  });
}

function applyResult(result, elements) {
  const { input, output, tree, status } = elements;

  if (!input.value.trim()) {
    output.textContent = "Paste JSON first.";
    tree.innerHTML = "";
    setStatus(status, "No input");
    return;
  }

  if (!result.ok) {
    output.textContent = result.message;
    tree.innerHTML = "";
    const location = result.line && result.column ? ` at line ${result.line}, column ${result.column}` : "";
    setStatus(status, `Invalid JSON${location}`, true);
    return;
  }

  output.textContent = result.value;
  const parsed = parseJson(result.value);
  tree.replaceChildren(...renderTree(parsed.ok ? toTreeNodes(parsed.value) : []));
  setStatus(status, "Formatted locally");
}

function renderTree(nodes) {
  return nodes.map((node) => {
    const details = document.createElement("details");
    details.className = `tree-node tree-${node.type}`;
    details.open = node.depth < 2;
    details.style.setProperty("--depth", node.depth);

    const summary = document.createElement("summary");
    const key = document.createElement("span");
    key.className = "tree-key";
    key.textContent = node.key;

    const type = document.createElement("span");
    type.className = "tree-type";
    type.textContent = node.type;

    const value = document.createElement("span");
    value.className = "tree-summary";
    value.textContent = node.summary;

    summary.append(key, type, value);
    details.append(summary);

    if (node.children.length) {
      details.append(...renderTree(node.children));
    }

    return details;
  });
}

async function copyOutput(text, status) {
  const value = text.trim();
  if (!value || value === "Formatted JSON will appear here.") {
    setStatus(status, "Nothing to copy", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus(status, "Copied");
  } catch {
    setStatus(status, "Copy blocked by browser", true);
  }
}

function setStatus(status, message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ready";
}
