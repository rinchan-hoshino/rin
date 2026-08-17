import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const config = await importBuiltModule<{
  MEMORY_TASK_THINKING_LEVEL: string;
}>("dist/core/rin-lib/memory-task-config.js");

test("memory tasks keep their low thinking-level contract", () => {
  assert.equal(config.MEMORY_TASK_THINKING_LEVEL, "low");
  assert.deepEqual(Object.keys(config), ["MEMORY_TASK_THINKING_LEVEL"]);
});
