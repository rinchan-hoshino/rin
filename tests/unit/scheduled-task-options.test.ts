import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const scheduledTaskOptionsMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "scheduled-task-options.js"))
    .href
);

test("scheduled task options expose targets and management without session modes", () => {
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_TARGET_KINDS, [
    "agent_prompt",
    "shell_command",
  ]);
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_MANAGE_ACTIONS, [
    "delete",
    "pause",
    "resume",
  ]);
  assert.equal(scheduledTaskOptionsMod.SCHEDULED_TASK_SESSION_MODES, undefined);
  assert.equal(
    scheduledTaskOptionsMod.DEFAULT_SCHEDULED_TASK_SESSION_MODE,
    undefined,
  );
  assert.equal(
    scheduledTaskOptionsMod.normalizeScheduledTaskSessionMode,
    undefined,
  );
  assert.equal(scheduledTaskOptionsMod.isScheduledTaskSessionMode, undefined);
});
