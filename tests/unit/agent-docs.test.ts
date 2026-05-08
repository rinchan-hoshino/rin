import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

function readAgentDoc(relativePath: string) {
  return fs.readFileSync(
    path.join(rootDir, "docs", "agent", relativePath),
    "utf8",
  );
}

test("agent docs expose scheduled task operation workflow", () => {
  const readme = readAgentDoc("README.md");
  const capabilities = readAgentDoc("docs/capabilities.md");
  const scheduledTasks = readAgentDoc("docs/scheduled-tasks.md");

  assert.match(readme, /docs\/scheduled-tasks\.md/);
  assert.match(capabilities, /~\/\.rin\/docs\/rin\/docs\/scheduled-tasks\.md/);

  for (const command of [
    "cron_list_tasks",
    "cron_get_task",
    "cron_upsert_task",
    "cron_delete_task",
    "cron_complete_task",
    "cron_pause_task",
    "cron_resume_task",
  ]) {
    assert.match(scheduledTasks, new RegExp(command));
    assert.doesNotMatch(capabilities, new RegExp(command));
  }

  assert.match(scheduledTasks, /`session\.mode: "dedicated"`/);
  assert.match(scheduledTasks, /Re-read the task with `cron_get_task`/);
});
