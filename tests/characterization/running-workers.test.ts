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

test("identical running worker state does not rewrite the recovery record", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-idempotent-"),
  );
  try {
    const sessionFile = path.join(agentDir, "sessions", "active.jsonl");
    const statePath = runningWorkersStatePath(agentDir);

    setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "chat-inbox-stable",
      true,
    );
    const before = await fs.stat(statePath, { bigint: true });
    const beforeContent = await fs.readFile(statePath, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));

    setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "chat-inbox-stable",
      true,
    );
    const after = await fs.stat(statePath, { bigint: true });

    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(await fs.readFile(statePath, "utf8"), beforeContent);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("running worker records contain recovery identity but no presentation state", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-working-visible-"),
  );
  try {
    const sessionFile = path.join(agentDir, "sessions", "active.jsonl");

    setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "chat-inbox-working",
      true,
    );
    assert.deepEqual(listRunningWorkerSessions(agentDir), [
      {
        sessionFile,
        requestTag: "chat-inbox-working",
        frontendOwner: true,
      },
    ]);

    setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "chat-inbox-working",
      true,
    );
    assert.deepEqual(listRunningWorkerSessions(agentDir), [
      {
        sessionFile,
        requestTag: "chat-inbox-working",
        frontendOwner: true,
      },
    ]);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("running worker records discard retired presentation fields", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-working-orphan-"),
  );
  try {
    const sessionFile = path.join(agentDir, "sessions", "orphan.jsonl");
    const statePath = runningWorkersStatePath(agentDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        sessionFiles: [sessionFile],
        frontendOwners: { [sessionFile]: false },
        workingVisibilities: { [sessionFile]: true },
      })}\n`,
    );

    assert.deepEqual(listRunningWorkerSessions(agentDir), [{ sessionFile }]);

    setRunningWorkerSession(agentDir, sessionFile, true, undefined, false);
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(persisted.workingVisibilities, undefined);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("running worker updates normalize duplicate legacy session entries", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-running-workers-duplicates-"),
  );
  try {
    const sessionFile = path.join(agentDir, "sessions", "active.jsonl");
    const statePath = runningWorkersStatePath(agentDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sessionFiles: [sessionFile, sessionFile],
          requestTags: { [sessionFile]: "chat-inbox-stable" },
        },
        null,
        2,
      )}\n`,
    );

    setRunningWorkerSession(
      agentDir,
      sessionFile,
      true,
      "chat-inbox-stable",
      true,
    );

    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), {
      schemaVersion: 1,
      sessionFiles: [sessionFile],
      requestTags: { [sessionFile]: "chat-inbox-stable" },
      frontendOwners: { [sessionFile]: true },
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

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
