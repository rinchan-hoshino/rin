import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const metadata = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "metadata.js"))
    .href
);

test("session metadata normalizes explicit and manager-backed values", () => {
  const manager = {
    getSessionId: () => " manager-session ",
    getSessionFile: () => " /tmp/manager.jsonl ",
    getLeafId: () => " manager-leaf ",
    getSessionName: () => " manager-name ",
    getCwd: () => " /tmp/manager-cwd ",
    isPersisted: () => true,
  };

  assert.equal(metadata.normalizeSessionValue("  "), undefined);
  assert.equal(metadata.normalizeSessionValue(42), "42");

  const normalized = metadata.readSessionMetadata({
    sessionManager: manager,
    sessionId: " explicit-session ",
    sessionFile: " /tmp/explicit.jsonl ",
    leafId: " explicit-leaf ",
    sessionName: " explicit-name ",
    cwd: " /tmp/explicit-cwd ",
  });

  assert.deepEqual(normalized, {
    sessionId: "explicit-session",
    sessionFile: "/tmp/explicit.jsonl",
    leafId: "explicit-leaf",
    sessionName: "explicit-name",
    cwd: "/tmp/explicit-cwd",
    sessionPersisted: true,
  });
});

test("session identity falls back from file to id to cwd", () => {
  assert.equal(
    metadata.readSessionIdentity({
      sessionFile: " /tmp/a.jsonl ",
      sessionId: " session-a ",
      cwd: " /tmp/cwd-a ",
    }),
    "/tmp/a.jsonl",
  );
  assert.equal(
    metadata.readSessionIdentity({
      sessionId: " session-b ",
      cwd: " /tmp/cwd-b ",
    }),
    "session-b",
  );
  assert.equal(
    metadata.readSessionIdentity({
      cwd: " /tmp/cwd-c ",
    }),
    "/tmp/cwd-c",
  );
});

test("session metadata keeps non-persisted sessions detached from blank files", () => {
  const normalized = metadata.readSessionMetadata({
    sessionManager: {
      getSessionId: () => " session-c ",
      getSessionFile: () => "   ",
      getCwd: () => " /tmp/cwd-c ",
      isPersisted: () => true,
    },
  });

  assert.equal(normalized.sessionId, "session-c");
  assert.equal(normalized.sessionFile, "");
  assert.equal(normalized.sessionPersisted, false);
});

test("session metadata falls back when explicit values normalize to empty", () => {
  const normalized = metadata.readSessionMetadata({
    sessionManager: {
      getSessionId: () => " manager-session ",
      getSessionFile: () => " /tmp/manager.jsonl ",
      getLeafId: () => " manager-leaf ",
      getSessionName: () => " manager-name ",
      getCwd: () => " /tmp/manager-cwd ",
      isPersisted: () => true,
    },
    sessionId: "   ",
    sessionFile: "   ",
    leafId: "   ",
    sessionName: "   ",
    cwd: "   ",
  });

  assert.deepEqual(normalized, {
    sessionId: "manager-session",
    sessionFile: "/tmp/manager.jsonl",
    leafId: "manager-leaf",
    sessionName: "manager-name",
    cwd: "/tmp/manager-cwd",
    sessionPersisted: true,
  });
});
