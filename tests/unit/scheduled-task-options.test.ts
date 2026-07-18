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

test("scheduled task options expose only independent execution modes", () => {
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_TARGET_KINDS, [
    "agent_prompt",
    "shell_command",
  ]);
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_SESSION_MODES, [
    "none",
    "dedicated",
  ]);
  assert.deepEqual(scheduledTaskOptionsMod.SCHEDULED_TASK_MANAGE_ACTIONS, [
    "delete",
    "pause",
    "resume",
  ]);
  assert.equal(
    scheduledTaskOptionsMod.DEFAULT_SCHEDULED_TASK_SESSION_MODE,
    "none",
  );
});

test("scheduled task session mode normalization accepts only current modes", () => {
  for (const mode of scheduledTaskOptionsMod.SCHEDULED_TASK_SESSION_MODES) {
    assert.equal(
      scheduledTaskOptionsMod.normalizeScheduledTaskSessionMode(` ${mode} `),
      mode,
    );
    assert.equal(
      scheduledTaskOptionsMod.isScheduledTaskSessionMode(mode),
      true,
    );
  }
  for (const value of [undefined, null, "", "session_continue", "other", 42]) {
    assert.equal(
      scheduledTaskOptionsMod.normalizeScheduledTaskSessionMode(value),
      undefined,
    );
    assert.equal(
      scheduledTaskOptionsMod.isScheduledTaskSessionMode(value),
      false,
    );
  }
});
