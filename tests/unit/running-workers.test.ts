import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const workers = await importBuiltModule<{
  runningWorkersStatePath(agentDir: string): string;
  listRunningWorkerSessions(agentDir: string): Array<Record<string, unknown>>;
  listRunningWorkerSessionFiles(agentDir: string): string[];
  setRunningWorkerSession(
    agentDir: string,
    sessionFile: string,
    running: boolean,
    requestTag?: string,
    frontendOwner?: boolean,
  ): void;
}>("dist/core/rin-daemon/running-workers.js");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-"),
  );
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

test("running workers read legacy session state and preserve request ownership", async () => {
  await withAgentDir(async (agentDir) => {
    const sessionFile = path.join(agentDir, "sessions", "active.jsonl");
    const statePath = workers.runningWorkersStatePath(agentDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: 1, sessionFiles: [sessionFile] })}\n`,
    );
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile },
    ]);

    await fs.writeFile(
      statePath,
      `${JSON.stringify({ schemaVersion: 1, sessionFiles: [sessionFile], requestTags: { [sessionFile]: "chat-inbox-legacy" } })}\n`,
    );
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile, requestTag: "chat-inbox-legacy", frontendOwner: true },
    ]);

    workers.setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "stable",
      false,
    );
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile, requestTag: "stable" },
    ]);
    workers.setRunningWorkerSession(agentDir, sessionFile, true, "owner", true);
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile, requestTag: "owner", frontendOwner: true },
    ]);
    workers.setRunningWorkerSession(agentDir, sessionFile, true, "");
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile },
    ]);
    workers.setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      " durable tag ",
    );
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile, requestTag: " durable tag " },
    ]);
    workers.setRunningWorkerSession(agentDir, sessionFile, true);
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), [
      { sessionFile },
    ]);
    assert.deepEqual(workers.listRunningWorkerSessionFiles(agentDir), [
      sessionFile,
    ]);
    workers.setRunningWorkerSession(agentDir, sessionFile, false);
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), []);
  });
});

test("running workers fail closed for missing and malformed state", async () => {
  await withAgentDir(async (agentDir) => {
    const statePath = workers.runningWorkersStatePath(agentDir);
    assert.deepEqual(workers.listRunningWorkerSessions(agentDir), []);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    for (const value of ["bad", "null", "[]", '{"sessionFiles":"bad"}']) {
      await fs.writeFile(statePath, value);
      assert.deepEqual(workers.listRunningWorkerSessions(agentDir), []);
    }
  });
});
