import {
  findTreeMatches,
  flattenTreeNodes,
  formatJson,
  getCopyPayload,
  getPropertyRows,
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
  const elements = {
    input: root.querySelector("#json-input"),
    tree: root.querySelector("[data-json-tree]"),
    properties: root.querySelector("[data-json-properties]"),
    status: root.querySelector("[data-json-status]"),
    search: root.querySelector("[data-json-search]"),
    contextMenu: root.querySelector("[data-json-context-menu]"),
  };

  const state = {
    nodes: [],
    nodeMap: new Map(),
    selectedPath: "",
    matches: [],
    matchIndex: -1,
  };

  root.addEventListener("click", async (event) => {
    const menuButton = event.target.closest("[data-json-menu-action]");
    if (menuButton) {
      await handleContextMenuAction(menuButton.dataset.jsonMenuAction, elements, state);
      hideContextMenu(elements);
      return;
    }

    const summary = event.target.closest("[data-json-node]");
    if (summary) {
      event.preventDefault();
      selectPath(summary.dataset.path, elements, state);
      hideContextMenu(elements);
      return;
    }

    hideContextMenu(elements);

    const button = event.target.closest("[data-json-action]");
    if (!button) return;

    const action = button.dataset.jsonAction;
    if (action === "sample") {
      elements.input.value = JSON.stringify(sampleJson);
      applyFormat(elements, state);
      return;
    }

    if (action === "clear") {
      clearViewer(elements, state);
      return;
    }

    if (action === "format") {
      applyFormat(elements, state);
      return;
    }

    if (action === "minify") {
      applyMinify(elements, state);
      return;
    }

    if (action === "copy") {
      await copyInput(elements.input.value, elements.status);
      return;
    }

    if (action === "search") {
      runSearch(elements, state, 1);
      return;
    }

    if (action === "next") {
      moveMatch(elements, state, 1);
      return;
    }

    if (action === "previous") {
      moveMatch(elements, state, -1);
      return;
    }

    if (action === "expand") {
      setTreeExpanded(elements.tree, true);
      return;
    }

    if (action === "collapse") {
      setTreeExpanded(elements.tree, false);
    }
  });

  root.addEventListener("contextmenu", (event) => {
    const summary = event.target.closest("[data-json-node]");
    if (!summary) {
      hideContextMenu(elements);
      return;
    }

    event.preventDefault();
    selectPath(summary.dataset.path, elements, state);
    showContextMenu(elements, event.clientX, event.clientY);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu(elements);
    }
  });

  window.addEventListener("resize", () => hideContextMenu(elements));
  window.addEventListener("scroll", () => hideContextMenu(elements), true);

  elements.search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(elements, state, 1);
    }
  });

  elements.input.addEventListener("input", () => {
    const source = elements.input.value.trim();
    if (!source) {
      clearViewer(elements, state);
      return;
    }

    const result = parseJson(source);
    if (result.ok) {
      renderModel(result.value, elements, state);
      setStatus(elements.status, "Valid JSON");
      return;
    }

    setStatus(elements.status, invalidStatus(result), true);
  });
}

function applyFormat(elements, state) {
  const result = formatJson(elements.input.value);
  if (!handleResult(result, elements, state)) {
    return;
  }

  elements.input.value = result.value;
  setStatus(elements.status, "Formatted and tree view updated");
}

function applyMinify(elements, state) {
  const result = minifyJson(elements.input.value);
  if (!handleResult(result, elements, state)) {
    return;
  }

  elements.input.value = result.value;
  setStatus(elements.status, "Minified and tree view updated");
}

function handleResult(result, elements, state) {
  if (!elements.input.value.trim()) {
    setStatus(elements.status, "No input", true);
    return false;
  }

  if (!result.ok) {
    setStatus(elements.status, invalidStatus(result), true);
    elements.properties.replaceChildren(emptyPropertyRow("Invalid JSON. Properties are unavailable."));
    return false;
  }

  const parsed = parseJson(result.value);
  if (parsed.ok) {
    renderModel(parsed.value, elements, state);
  }

  return true;
}

function renderModel(value, elements, state) {
  state.nodes = toTreeNodes(value);
  state.nodeMap = new Map(flattenTreeNodes(state.nodes).map((node) => [node.path, node]));
  state.matches = [];
  state.matchIndex = -1;

  elements.tree.replaceChildren(...renderTree(state.nodes));
  selectPath(state.nodes[0]?.path || "", elements, state);
}

function renderTree(nodes) {
  return nodes.map((node) => {
    const details = document.createElement("details");
    details.className = `tree-node tree-${node.type}`;
    details.dataset.path = node.path;
    details.open = node.depth < 2;
    details.style.setProperty("--depth", node.depth);

    const summary = document.createElement("summary");
    summary.dataset.jsonNode = "";
    summary.dataset.path = node.path;

    const marker = document.createElement("span");
    marker.className = "tree-marker";
    marker.textContent = node.children.length ? iconFor(node.type) : "■";

    const key = document.createElement("span");
    key.className = "tree-key";
    key.textContent = node.key;

    const punctuation = document.createElement("span");
    punctuation.className = "tree-punctuation";
    punctuation.textContent = ":";

    const value = document.createElement("span");
    value.className = "tree-summary";
    value.textContent = node.summary;

    summary.append(marker, key, punctuation, value);
    details.append(summary);

    if (node.children.length) {
      const children = document.createElement("div");
      children.className = "tree-children";
      children.append(...renderTree(node.children));
      details.append(children);
    }

    return details;
  });
}

function selectPath(path, elements, state) {
  if (!path || !state.nodeMap.has(path)) {
    return;
  }

  state.selectedPath = path;
  openAncestors(elements.tree, path);

  elements.tree.querySelectorAll("[data-json-node]").forEach((node) => {
    node.classList.toggle("is-selected", node.dataset.path === path);
  });

  const selected = elements.tree.querySelector(`[data-json-node][data-path="${cssEscape(path)}"]`);
  selected?.scrollIntoView({ block: "nearest" });

  renderProperties(state.nodeMap.get(path), elements.properties);
}

function renderProperties(node, target) {
  const rows = getPropertyRows(node);
  if (!rows.length) {
    target.replaceChildren(emptyPropertyRow("No properties."));
    return;
  }

  target.replaceChildren(...rows.map((row) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const value = document.createElement("td");
    name.textContent = row.name;
    value.textContent = row.value;
    tr.append(name, value);
    return tr;
  }));
}

function runSearch(elements, state, direction) {
  state.matches = findTreeMatches(state.nodes, elements.search.value);
  state.matchIndex = direction > 0 ? 0 : state.matches.length - 1;
  markMatches(elements.tree, state.matches);

  if (!state.matches.length) {
    setStatus(elements.status, "No matches", true);
    return;
  }

  selectPath(state.matches[state.matchIndex], elements, state);
  setStatus(elements.status, `Found ${state.matches.length} ${state.matches.length === 1 ? "match" : "matches"}`);
}

function moveMatch(elements, state, direction) {
  if (!state.matches.length) {
    runSearch(elements, state, direction);
    return;
  }

  state.matchIndex = (state.matchIndex + direction + state.matches.length) % state.matches.length;
  selectPath(state.matches[state.matchIndex], elements, state);
  setStatus(elements.status, `Match ${state.matchIndex + 1} of ${state.matches.length}`);
}

function markMatches(tree, paths) {
  const pathSet = new Set(paths);
  tree.querySelectorAll("[data-json-node]").forEach((node) => {
    node.classList.toggle("is-match", pathSet.has(node.dataset.path));
  });
}

async function handleContextMenuAction(action, elements, state) {
  const selected = state.nodeMap.get(state.selectedPath);
  if (!selected) {
    setStatus(elements.status, "Select a node first", true);
    return;
  }

  if (action === "copy-key") {
    await copyText(getCopyPayload(selected, "key"), elements.status, "Key copied");
    return;
  }

  if (action === "copy-value") {
    await copyText(getCopyPayload(selected, "value"), elements.status, "Value copied");
    return;
  }

  if (action === "copy-pair") {
    await copyText(getCopyPayload(selected, "pair"), elements.status, "Key and value copied");
    return;
  }

  if (action === "expand-children") {
    setNodeSubtreeExpanded(elements.tree, selected.path, true);
    setStatus(elements.status, "Child nodes expanded");
    return;
  }

  if (action === "collapse-children") {
    setNodeSubtreeExpanded(elements.tree, selected.path, false);
    openAncestors(elements.tree, selected.path);
    setStatus(elements.status, "Child nodes collapsed");
    return;
  }

  if (action === "expand-all") {
    setTreeExpanded(elements.tree, true);
    setStatus(elements.status, "All nodes expanded");
    return;
  }

  if (action === "collapse-all") {
    setTreeExpanded(elements.tree, false);
    openAncestors(elements.tree, selected.path);
    setStatus(elements.status, "All nodes collapsed");
  }
}

function openAncestors(tree, path) {
  tree.querySelectorAll("details[data-path]").forEach((details) => {
    const current = details.dataset.path;
    if (current === "$" || path === current || path.startsWith(`${current}.`) || path.startsWith(`${current}[`)) {
      details.open = true;
    }
  });
}

function setNodeSubtreeExpanded(tree, path, expanded) {
  tree.querySelectorAll("details[data-path]").forEach((details) => {
    const current = details.dataset.path;
    if (current === path || current.startsWith(`${path}.`) || current.startsWith(`${path}[`)) {
      details.open = expanded;
    }
  });
}

function setTreeExpanded(tree, expanded) {
  tree.querySelectorAll("details").forEach((details) => {
    details.open = expanded || details.dataset.path === "$";
  });
}

function showContextMenu(elements, x, y) {
  const menu = elements.contextMenu;
  if (!menu) {
    return;
  }

  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";

  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function hideContextMenu(elements) {
  if (elements.contextMenu) {
    elements.contextMenu.hidden = true;
  }
}

function clearViewer(elements, state) {
  elements.input.value = "";
  state.nodes = [];
  state.nodeMap = new Map();
  state.selectedPath = "";
  state.matches = [];
  state.matchIndex = -1;
  elements.tree.innerHTML = '<div class="empty-view">Format or paste valid JSON to display its tree structure.</div>';
  elements.properties.replaceChildren(emptyPropertyRow("Select a node from the tree."));
  setStatus(elements.status, "Waiting for input");
}

async function copyInput(text, status) {
  const value = text.trim();
  if (!value) {
    setStatus(status, "Nothing to copy", true);
    return;
  }

  try {
    await writeClipboard(value);
    setStatus(status, "Copied");
  } catch {
    setStatus(status, "The browser blocked clipboard access", true);
  }
}

async function copyText(value, status, successMessage) {
  if (!value) {
    setStatus(status, "Nothing to copy", true);
    return;
  }

  try {
    await writeClipboard(value);
    setStatus(status, successMessage);
  } catch {
    setStatus(status, "The browser blocked clipboard access", true);
  }
}

async function writeClipboard(value) {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }

  await navigator.clipboard.writeText(value);
}

function emptyPropertyRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 2;
  cell.textContent = message;
  row.append(cell);
  return row;
}

function invalidStatus(result) {
  const location = result.line && result.column ? ` at line ${result.line}, column ${result.column}` : "";
  return `Invalid JSON${location}`;
}

function iconFor(type) {
  if (type === "array") {
    return "[]";
  }

  if (type === "object") {
    return "{}";
  }

  return "■";
}

function setStatus(status, message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ready";
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}
