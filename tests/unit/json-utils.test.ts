import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const jsonUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "json-utils.js")).href
);

test("json utils clone helpers return detached JSON-safe copies", () => {
  const source = {
    nested: { token: "secret" },
    items: [{ value: 1 }],
  };
  const cloned = jsonUtils.cloneJson(source);
  const clonedItems = jsonUtils.cloneJsonIfObject(source.items);

  cloned.nested.token = "updated";
  cloned.items[0].value = 2;
  clonedItems[0].value = 3;

  assert.equal(source.nested.token, "secret");
  assert.equal(source.items[0].value, 1);
});

test("json utils object helpers preserve object guards", () => {
  const arrayValue = [{ demo: true }];
  const clonedArray = jsonUtils.cloneJsonIfObject(arrayValue);

  clonedArray[0].demo = false;

  assert.equal(arrayValue[0].demo, true);
  assert.deepEqual(jsonUtils.cloneJsonIfObject(undefined), undefined);
  assert.deepEqual(jsonUtils.cloneJsonIfObject(null), undefined);
  assert.deepEqual(jsonUtils.cloneJsonIfObject("text"), undefined);
  assert.deepEqual(
    jsonUtils.cloneJsonIfObject(() => undefined),
    undefined,
  );
  assert.equal(jsonUtils.isJsonRecord({ demo: true }), true);
  assert.equal(jsonUtils.isJsonRecord([]), false);
  assert.equal(jsonUtils.isJsonRecord(null), false);
});

test("json utils array guard preserves arrays and rejects other values", () => {
  const values = [{ id: 1 }];

  assert.equal(jsonUtils.asArray(values), values);
  assert.deepEqual(jsonUtils.asArray({ id: 1 }), []);
  assert.deepEqual(jsonUtils.asArray(null), []);
  assert.deepEqual(jsonUtils.asArray("value"), []);
});
