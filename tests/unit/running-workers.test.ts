import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const {
  listRunningWorkerSessions,
  runningWorkersStatePath,
  setRunningWorkerSession,
} = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "running-workers.js"),
  ).href
);

test("running worker records preserve legacy session-only state and durable request tags", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-"),
  );
  const sessionFile = path.join(agentDir, "sessions", "active.jsonl");
  const statePath = runningWorkersStatePath(agentDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ schemaVersion: 1, sessionFiles: [sessionFile] })}\n`,
  );

  assert.deepEqual(listRunningWorkerSessions(agentDir), [{ sessionFile }]);

  setRunningWorkerSession(agentDir, sessionFile, true, "chat-inbox-stable");
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    { sessionFile, requestTag: "chat-inbox-stable" },
  ]);

  setRunningWorkerSession(agentDir, sessionFile, true);
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    { sessionFile, requestTag: "chat-inbox-stable" },
  ]);

  setRunningWorkerSession(agentDir, sessionFile, false);
  assert.deepEqual(listRunningWorkerSessions(agentDir), []);

  await fs.rm(agentDir, { recursive: true, force: true });
});
