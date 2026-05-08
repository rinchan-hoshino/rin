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
    "rin.tasks.run",
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
    "cron_pause_task",
    "cron_resume_task",
  ]) {
    assert.doesNotMatch(capabilities, new RegExp(command));
  }

  assert.match(agentSdk, /"src", "core", "rin-agent-sdk", "index\.ts"/);
  assert.match(scheduledTasks, /`session\.mode: "dedicated"`/);
  assert.match(
    scheduledTasks,
    /After changing or starting a task, re-read daemon-visible state/,
  );
});
