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
  const builtinCapabilities = readAgentDoc("docs/builtin-extensions.md");
  const scheduledTasks = readAgentDoc("docs/scheduled-tasks.md");
  const agentSdk = readAgentDoc("docs/agent-sdk.md");

  assert.match(readme, /docs\/agent-sdk\.md/);
  assert.match(readme, /docs\/scheduled-tasks\.md/);
  assert.match(capabilities, /agent-sdk\.md/);
  assert.match(capabilities, /scheduled-tasks\.md/);
  assert.match(builtinCapabilities, /agent-sdk\.md/);
  assert.match(builtinCapabilities, /scheduled-tasks\.md/);

  for (const helper of [
    "rin.tasks.list",
    "rin.tasks.get",
    "rin.tasks.upsert",
    "rin.tasks.delete",
    "rin.tasks.complete",
    "rin.tasks.pause",
    "rin.tasks.resume",
    "rin.tasks.rescheduleOnce",
    "rin.tasks.run",
    "rin.tasks.wake",
  ]) {
    assert.match(scheduledTasks, new RegExp(helper.replace(/\./g, "\\.")));
    assert.match(agentSdk, new RegExp(helper.replace(/\./g, "\\.")));
  }

  for (const command of [
    "cron_list_tasks",
    "cron_get_task",
    "cron_upsert_task",
    "cron_delete_task",
    "cron_complete_task",
    "cron_run_task",
    "cron_wake_task",
    "cron_pause_task",
    "cron_resume_task",
    "cron_reschedule_once_task",
  ]) {
    assert.doesNotMatch(capabilities, new RegExp(command));
  }

  assert.match(agentSdk, /"dist", "core", "rin-agent-sdk", "index\.js"/);
  assert.doesNotMatch(agentSdk, /"src", "core", "rin-agent-sdk", "index\.ts"/);
  assert.match(scheduledTasks, /`session\.mode: "dedicated"`/);
  assert.match(scheduledTasks, /target\.prompt.*target\.continuationPrompt/s);
  assert.match(
    scheduledTasks,
    /Ordinary recurring tasks should not use a dedicated session/,
  );
  assert.match(scheduledTasks, /store durable state explicitly/);
  assert.match(scheduledTasks, /code: string/);
  assert.match(
    scheduledTasks,
    /termination\?: \{ maxRuns\?: number; stopAt\?: string \}/,
  );
  assert.match(scheduledTasks, /session\.mode: "session_instruction"/);
  assert.match(
    scheduledTasks,
    /Use `condition` when the schedule should wake only if agent-authored TypeScript returns true/,
  );
  assert.match(
    scheduledTasks,
    /Required verification after a create\/update\/run-state change/,
  );
});
