import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const scheduledTaskOptionsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "scheduled-task-options.js"))
    .href
);

test("scheduled task options expose only independent execution modes", () => {
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_TARGET_KINDS, [
    "agent_prompt",
    "shell_command",
  ]);
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_SESSION_MODES, [
    "none",
    "dedicated",
  ]);
});
