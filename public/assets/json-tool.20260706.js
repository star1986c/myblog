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
      output.textContent = "格式化后的 JSON 会显示在这里。";
      tree.innerHTML = "";
      setStatus(status, "等待输入");
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
      output.textContent = "格式化后的 JSON 会显示在这里。";
      tree.innerHTML = "";
      setStatus(status, "等待输入");
      return;
    }

    const result = parseJson(input.value);
    if (result.ok) {
      setStatus(status, "JSON 有效");
    }
  });
}

function applyResult(result, elements) {
  const { input, output, tree, status } = elements;

  if (!input.value.trim()) {
    output.textContent = "请先粘贴 JSON。";
    tree.innerHTML = "";
    setStatus(status, "没有输入");
    return;
  }

  if (!result.ok) {
    output.textContent = result.message;
    tree.innerHTML = "";
    const location = result.line && result.column ? `，第 ${result.line} 行，第 ${result.column} 列` : "";
    setStatus(status, `JSON 无效${location}`, true);
    return;
  }

  output.textContent = result.value;
  const parsed = parseJson(result.value);
  tree.replaceChildren(...renderTree(parsed.ok ? toTreeNodes(parsed.value) : []));
  setStatus(status, "已在本地处理");
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
  if (!value || value === "格式化后的 JSON 会显示在这里。") {
    setStatus(status, "没有可复制内容", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setStatus(status, "已复制");
  } catch {
    setStatus(status, "浏览器阻止复制", true);
  }
}

function setStatus(status, message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ready";
}
