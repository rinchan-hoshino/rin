import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type SessionInput = Record<string, unknown>;
type SessionMetadata = {
  sessionId: string;
  sessionFile: string;
  leafId: string;
  sessionName: string;
  cwd: string;
  sessionPersisted: boolean;
};
const metadata = await importBuiltModule<{
  normalizeSessionValue(value: unknown): string | undefined;
  readSessionMetadata(input: SessionInput | null): SessionMetadata;
  readSessionIdentity(input: SessionInput | null): string;
}>("dist/core/session/metadata.js");

function manager(values: Record<string, unknown> = {}) {
  return {
    getSessionId: () => values.sessionId,
    getSessionFile: () => values.sessionFile,
    getLeafId: () => values.leafId,
    getSessionName: () => values.sessionName,
    getCwd: () => values.cwd,
    isPersisted: () => values.persisted,
  };
}

test("session metadata prefers normalized explicit values over manager fallbacks", () => {
  assert.equal(metadata.normalizeSessionValue("  "), undefined);
  assert.equal(metadata.normalizeSessionValue(42), "42");
  assert.deepEqual(
    metadata.readSessionMetadata({
      sessionManager: manager({ persisted: true }),
      sessionId: " explicit-session ",
      sessionFile: " /tmp/explicit.jsonl ",
      leafId: " explicit-leaf ",
      sessionName: " explicit-name ",
      cwd: " /tmp/explicit-cwd ",
    }),
    {
      sessionId: "explicit-session",
      sessionFile: "/tmp/explicit.jsonl",
      leafId: "explicit-leaf",
      sessionName: "explicit-name",
      cwd: "/tmp/explicit-cwd",
      sessionPersisted: true,
    },
  );
});

test("session metadata falls back to manager values and rejects blank persistence", () => {
  assert.deepEqual(
    metadata.readSessionMetadata({
      sessionManager: manager({
        sessionId: " manager-session ",
        sessionFile: " /tmp/manager.jsonl ",
        leafId: " manager-leaf ",
        sessionName: " manager-name ",
        cwd: " /tmp/manager-cwd ",
        persisted: true,
      }),
      sessionId: " ",
      sessionFile: " ",
    }),
    {
      sessionId: "manager-session",
      sessionFile: "/tmp/manager.jsonl",
      leafId: "manager-leaf",
      sessionName: "manager-name",
      cwd: "/tmp/manager-cwd",
      sessionPersisted: true,
    },
  );
  const detached = metadata.readSessionMetadata({
    sessionManager: manager({
      sessionId: "id",
      sessionFile: " ",
      persisted: true,
    }),
  });
  assert.equal(detached.sessionFile, "");
  assert.equal(detached.sessionPersisted, false);
});

test("session metadata accepts a manager directly and a null source", () => {
  assert.equal(
    metadata.readSessionMetadata(
      manager({
        sessionId: "direct",
        sessionFile: "/tmp/direct.jsonl",
        cwd: "/tmp/direct",
        persisted: true,
      }),
    ).sessionId,
    "direct",
  );
  const empty = metadata.readSessionMetadata(null);
  assert.equal(empty.sessionId, "");
  assert.equal(empty.sessionFile, "");
  assert.equal(empty.sessionPersisted, false);
});

test("session identity falls back from file to id to cwd", () => {
  assert.equal(
    metadata.readSessionIdentity({
      sessionFile: " /tmp/a ",
      sessionId: "id",
      cwd: "cwd",
    }),
    "/tmp/a",
  );
  assert.equal(
    metadata.readSessionIdentity({ sessionId: " id ", cwd: "cwd" }),
    "id",
  );
  assert.equal(metadata.readSessionIdentity({ cwd: " /tmp/cwd " }), "/tmp/cwd");
});
