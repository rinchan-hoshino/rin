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
  const nonInteractiveCli = readAgentDoc("docs/non-interactive-cli.md");
  const scheduledTasks = readAgentDoc("docs/scheduled-tasks.md");
  const agentSdk = readAgentDoc("docs/agent-sdk.md");
  const practiceIndex = readAgentDoc("practices/README.md");
  const browserUsePractice = readAgentDoc("practices/browser-use.md");
  const computerUsePractice = readAgentDoc("practices/computer-use.md");

  assert.match(readme, /docs\/agent-sdk\.md/);
  assert.match(readme, /docs\/scheduled-tasks\.md/);
  assert.match(readme, /practices\/browser-use\.md/);
  assert.match(readme, /practices\/computer-use\.md/);
  assert.match(capabilities, /agent-sdk\.md/);
  assert.match(capabilities, /scheduled-tasks\.md/);
  assert.match(builtinCapabilities, /agent-sdk\.md/);
  assert.match(builtinCapabilities, /scheduled-tasks\.md/);
  assert.match(capabilities, /Subagent \/ non-interactive work/);
  assert.match(nonInteractiveCli, /--managed-session <leaf>/);
  assert.match(nonInteractiveCli, /sessions\/managed\/<leaf>/);
  assert.match(
    builtinCapabilities,
    /do not assume a `run_subagent` tool exists/,
  );
  assert.doesNotMatch(builtinCapabilities, /provides `run_subagent`/);
  assert.match(builtinCapabilities, /does not ship bundled Browser Use/);
  assert.match(capabilities, /does not ship bundled `browser_use`/);

  assert.match(practiceIndex, /# Practices/);
  assert.doesNotMatch(practiceIndex, /Best Practices/i);
  assert.match(browserUsePractice, /headless/);
  assert.match(browserUsePractice, /headful/);
  assert.match(browserUsePractice, /Remote browser use/);
  assert.match(computerUsePractice, /Local Linux/);
  assert.match(computerUsePractice, /Local Windows/);
  assert.match(computerUsePractice, /Local macOS/);
  assert.match(computerUsePractice, /Remote computer use/);

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
