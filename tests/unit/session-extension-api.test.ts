import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDaemonSessionAPI,
  createDaemonSessionRef,
  SessionConversationReader,
} from "../../dist/core/session/extension-api.js";

function writeSession(filePath: string, entries: unknown[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

const header = {
  type: "session",
  version: 3,
  id: "session-test",
  timestamp: "2026-08-10T00:00:00.000Z",
  cwd: "/tmp",
};

const userMessage = {
  type: "message",
  id: "message-test",
  parentId: null,
  timestamp: "2026-08-10T00:00:01.000Z",
  message: {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    timestamp: 1,
  },
};

test("daemon session API owns lifecycle for opaque session refs", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-session-api-"));
  const emptyFile = path.join(agentDir, "sessions", "empty.jsonl");
  const waitingFile = path.join(agentDir, "sessions", "waiting.jsonl");
  writeSession(emptyFile, [header]);
  writeSession(waitingFile, [header, userMessage]);

  try {
    const emptyRef = createDaemonSessionRef(agentDir, emptyFile);
    const waitingRef = createDaemonSessionRef(agentDir, waitingFile);
    const missingRef = createDaemonSessionRef(
      agentDir,
      path.join(agentDir, "sessions", "missing.jsonl"),
    );
    assert.equal(createDaemonSessionRef(agentDir, ""), null);
    assert.ok(emptyRef);
    assert.ok(waitingRef);
    assert.ok(missingRef);
    assert.equal(emptyRef.token.includes(agentDir), false);

    const api = createDaemonSessionAPI({
      agentDir,
      getActivity: () => ({
        workers: [{ sessionFile: emptyFile, turnActive: true }],
      }),
    });
    assert.deepEqual(
      await api.getStates([null, emptyRef, waitingRef, missingRef]),
      ["idle", "executing", "waiting", "idle"],
    );
    await assert.rejects(
      api.getStates([{ token: "invalid" }]),
      /Session reference is invalid or expired/,
    );
    await assert.rejects(
      api.getStates([{ token: "rin-session-v1:" }]),
      /Session reference is invalid or expired/,
    );

    const compactingApi = createDaemonSessionAPI({
      agentDir,
      getActivity: () => ({
        workers: [{ sessionFile: waitingFile, isCompacting: true }],
      }),
      conversationReader: new SessionConversationReader(),
    });
    assert.deepEqual(await compactingApi.getStates([waitingRef]), [
      "executing",
    ]);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("session conversation reader caches an unchanged session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-session-reader-"));
  const sessionFile = path.join(root, "session.jsonl");
  writeSession(sessionFile, [header, userMessage]);
  try {
    const reader = new SessionConversationReader();
    assert.equal(await reader.hasConversation(sessionFile), true);
    assert.equal(await reader.hasConversation(sessionFile), true);
    await assert.rejects(
      reader.hasConversation(`${root}\0invalid`),
      /null bytes|must be a string/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
