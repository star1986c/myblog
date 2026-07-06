export function parseJson(input) {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (error) {
    return {
      ok: false,
      message: normalizeJsonErrorMessage(error),
      ...resolveErrorLocation(input, error),
    };
  }
}

export function formatJson(input, spaces = 2) {
  const result = parseJson(input);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: JSON.stringify(result.value, null, spaces),
  };
}

export function minifyJson(input) {
  const result = parseJson(input);
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    value: JSON.stringify(result.value),
  };
}

export function toTreeNodes(value, key = "root", depth = 0, path = "$") {
  if (Array.isArray(value)) {
    return [{
      key,
      path,
      type: "array",
      summary: `[${value.length}]`,
      depth,
      children: value.flatMap((item, index) => toTreeNodes(item, String(index), depth + 1, `${path}[${index}]`)),
    }];
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return [{
      key,
      path,
      type: "object",
      summary: `{${entries.length}}`,
      depth,
      children: entries.flatMap(([childKey, childValue]) => {
        return toTreeNodes(childValue, childKey, depth + 1, childPath(path, childKey));
      }),
    }];
  }

  return [{
    key,
    path,
    type: value === null ? "null" : typeof value,
    summary: JSON.stringify(value),
    depth,
    children: [],
  }];
}

export function flattenTreeNodes(nodes) {
  return nodes.flatMap((node) => [node, ...flattenTreeNodes(node.children)]);
}

export function getPropertyRows(node) {
  if (!node) {
    return [];
  }

  if (node.children.length) {
    return node.children.map((child) => ({
      name: child.key,
      value: child.summary,
    }));
  }

  return [{
    name: node.key,
    value: node.summary,
  }];
}

export function findTreeMatches(nodes, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  return flattenTreeNodes(nodes)
    .filter((node) => {
      return [node.key, node.type, node.summary]
        .some((item) => String(item).toLowerCase().includes(normalized));
    })
    .map((node) => node.path);
}

function childPath(parentPath, key) {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) {
    return `${parentPath}.${key}`;
  }

  return `${parentPath}[${JSON.stringify(key)}]`;
}

function normalizeJsonErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("JSON") ? message : `Invalid JSON: ${message}`;
}

function resolveErrorLocation(input, error) {
  const message = error instanceof Error ? error.message : String(error);
  const explicit = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (explicit) {
    return {
      line: Number(explicit[1]),
      column: Number(explicit[2]),
    };
  }

  const position = message.match(/position\s+(\d+)/i);
  if (!position) {
    return { line: 1, column: 1 };
  }

  return locationFromPosition(input, Number(position[1]));
}

function locationFromPosition(input, position) {
  const source = input.slice(0, Math.max(0, position));
  const lines = source.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}
