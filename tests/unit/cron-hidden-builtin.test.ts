import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CronScheduler } from "../../src/core/rin-daemon/cron.js";

async function tempAgentDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-hidden-builtin-"));
}

test("hidden builtin tasks run internally without appearing in ordinary task views", async () => {
  const agentDir = await tempAgentDir();
  const scheduler = new CronScheduler({ agentDir });
  scheduler.start();
  scheduler.stop();

  assert.equal(
    scheduler
      .listTasks({ includeBuiltIn: true })
      .some((task) => task.id === "builtin_agent_practices_docs_sync_daily"),
    false,
  );
  assert.equal(
    scheduler.getTask("builtin_agent_practices_docs_sync_daily", {
      includeBuiltIn: true,
    }),
    undefined,
  );

  const hidden = scheduler.getTask("builtin_agent_practices_docs_sync_daily", {
    includeBuiltIn: true,
    includeHidden: true,
  });
  assert.ok(hidden);
  assert.equal(hidden.builtIn, true);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.trigger.expression, "23 4 * * *");
  assert.equal(hidden.target.kind, "shell_command");
  assert.match(hidden.target.command, /__docs_internal sync-practices/);

  const status = scheduler.getStatusSnapshot({ includeBuiltIn: true });
  assert.equal(
    status.tasks.some(
      (task: any) => task.id === "builtin_agent_practices_docs_sync_daily",
    ),
    false,
  );
  assert.equal(status.builtInTaskCount, 2);
});
