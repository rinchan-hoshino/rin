import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      sessionFiles: [sessionFile],
      requestTags: { [sessionFile]: "chat-inbox-legacy" },
    })}\n`,
  );
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    {
      sessionFile,
      requestTag: "chat-inbox-legacy",
      frontendOwner: true,
    },
  ]);

  setRunningWorkerSession(
    agentDir,
    sessionFile,
    true,
    "chat-inbox-stable",
    true,
  );
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    {
      sessionFile,
      requestTag: "chat-inbox-stable",
      frontendOwner: true,
    },
  ]);

  setRunningWorkerSession(
    agentDir,
    sessionFile,
    true,
    "chat-inbox-explicit-non-owner",
    false,
  );
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    { sessionFile, requestTag: "chat-inbox-explicit-non-owner" },
  ]);

  setRunningWorkerSession(agentDir, sessionFile, true, "");
  assert.deepEqual(listRunningWorkerSessions(agentDir), [{ sessionFile }]);

  setRunningWorkerSession(agentDir, sessionFile, true, " durable tag ");
  assert.deepEqual(listRunningWorkerSessions(agentDir), [
    { sessionFile, requestTag: " durable tag " },
  ]);

  setRunningWorkerSession(agentDir, sessionFile, true);
  assert.deepEqual(listRunningWorkerSessions(agentDir), [{ sessionFile }]);

  setRunningWorkerSession(agentDir, sessionFile, false);
  assert.deepEqual(listRunningWorkerSessions(agentDir), []);

  await fs.rm(agentDir, { recursive: true, force: true });
});
