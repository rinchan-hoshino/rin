import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const task = await importBuiltModule<{
  default(): { name?: string; tools?: unknown[] };
}>("dist/core/task/index.js");

test("task capability exposes an independent empty tool surface", () => {
  const first = task.default();
  const second = task.default();
  assert.deepEqual(first, { name: "task", tools: [] });
  assert.notEqual(first, second);
  assert.notEqual(first.tools, second.tools);
});
