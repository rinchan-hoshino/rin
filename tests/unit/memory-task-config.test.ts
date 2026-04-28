import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const mod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "memory-task-config.js"),
  ).href
);

test("memory task config fixes recall-related thinking at low", () => {
  assert.equal(mod.MEMORY_TASK_THINKING_LEVEL, "low");
});
