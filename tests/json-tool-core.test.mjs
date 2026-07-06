import assert from "node:assert/strict";
import test from "node:test";

import {
  findTreeMatches,
  formatJson,
  getCopyPayload,
  getPropertyRows,
  minifyJson,
  parseJson,
  toTreeNodes,
} from "../public/assets/json-tool-core.20260706.js";

test("formatJson pretty prints valid JSON with two-space indentation", () => {
  const result = formatJson('{"name":"AI Build Lab","items":[1,true,null]}');

  assert.equal(result.ok, true);
  assert.equal(
    result.value,
    '{\n  "name": "AI Build Lab",\n  "items": [\n    1,\n    true,\n    null\n  ]\n}',
  );
});

test("minifyJson removes whitespace while preserving JSON value", () => {
  const result = minifyJson('{\n  "enabled": true,\n  "count": 3\n}');

  assert.deepEqual(result, {
    ok: true,
    value: '{"enabled":true,"count":3}',
  });
});

test("parseJson reports line and column for invalid JSON", () => {
  const result = parseJson('{\n  "name": "AI",\n}');

  assert.equal(result.ok, false);
  assert.equal(result.line, 3);
  assert.equal(result.column, 1);
  assert.match(result.message, /JSON/);
});

test("toTreeNodes creates readable nested object and array nodes", () => {
  const result = parseJson('{"user":{"name":"Star"},"roles":["admin","dev"]}');
  assert.equal(result.ok, true);

  const nodes = toTreeNodes(result.value);

  assert.deepEqual(nodes, [
    {
      key: "root",
      path: "$",
      type: "object",
      summary: "{2}",
      depth: 0,
      children: [
        {
          key: "user",
          path: "$.user",
          type: "object",
          summary: "{1}",
          depth: 1,
          children: [
            {
              key: "name",
              path: "$.user.name",
              type: "string",
              summary: '"Star"',
              depth: 2,
              children: [],
            },
          ],
        },
        {
          key: "roles",
          path: "$.roles",
          type: "array",
          summary: "[2]",
          depth: 1,
          children: [
            {
              key: "0",
              path: "$.roles[0]",
              type: "string",
              summary: '"admin"',
              depth: 2,
              children: [],
            },
            {
              key: "1",
              path: "$.roles[1]",
              type: "string",
              summary: '"dev"',
              depth: 2,
              children: [],
            },
          ],
        },
      ],
    },
  ]);
});

test("getPropertyRows returns Name and Value rows for the selected array node", () => {
  const result = parseJson('{"features":["format","minify","tree view","copy"]}');
  assert.equal(result.ok, true);

  const root = toTreeNodes(result.value)[0];
  const features = root.children.find((node) => node.key === "features");

  assert.deepEqual(getPropertyRows(features), [
    { name: "0", value: '"format"' },
    { name: "1", value: '"minify"' },
    { name: "2", value: '"tree view"' },
    { name: "3", value: '"copy"' },
  ]);
});

test("findTreeMatches finds key and value matches across the tree", () => {
  const result = parseJson('{"name":"AI Build Lab","features":["format","minify"]}');
  assert.equal(result.ok, true);

  const nodes = toTreeNodes(result.value);

  assert.deepEqual(findTreeMatches(nodes, "format"), ["$.features[0]"]);
  assert.deepEqual(findTreeMatches(nodes, "features"), ["$.features"]);
});

test("getCopyPayload returns key, value, and key plus value for a tree node", () => {
  const result = parseJson('{"url":"https://superstar1014.qzz.io/"}');
  assert.equal(result.ok, true);

  const root = toTreeNodes(result.value)[0];
  const url = root.children.find((node) => node.key === "url");

  assert.equal(getCopyPayload(url, "key"), "url");
  assert.equal(getCopyPayload(url, "value"), '"https://superstar1014.qzz.io/"');
  assert.equal(getCopyPayload(url, "pair"), 'url : "https://superstar1014.qzz.io/"');
});
