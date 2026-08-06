import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sessionRef = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "ref.js")).href
);

test("session ref helpers normalize shared command/state shapes and resolve consistently", () => {
  assert.deepEqual(
    sessionRef.normalizeSessionRef({
      sessionPath: " /tmp/demo.jsonl ",
      sessionId: " demo-session ",
    }),
    {
      sessionFile: "/tmp/demo.jsonl",
      sessionId: "demo-session",
    },
  );

  assert.deepEqual(
    sessionRef.normalizeSessionRef({
      sessionFile: " /tmp/command.jsonl ",
      sessionPath: " /tmp/ignored.jsonl ",
      sessionId: " command-session ",
    }),
    {
      sessionFile: "/tmp/command.jsonl",
      sessionId: "command-session",
    },
  );

  assert.deepEqual(
    sessionRef.normalizeSessionRef({
      sessionFile: "   ",
      sessionPath: " /tmp/fallback.jsonl ",
      sessionId: " state-session ",
    }),
    {
      sessionFile: "/tmp/fallback.jsonl",
      sessionId: "state-session",
    },
  );

  assert.equal(
    sessionRef.hasSessionRef({ sessionId: undefined, sessionFile: undefined }),
    false,
  );
  assert.equal(sessionRef.hasSessionRef({ sessionId: "   " }), false);
  assert.equal(sessionRef.hasSessionRef({ sessionId: "demo-session" }), true);

  assert.deepEqual(
    sessionRef.resolveSessionRef(
      {},
      { sessionFile: "/tmp/fallback.jsonl", sessionId: "fallback" },
    ),
    { sessionFile: "/tmp/fallback.jsonl", sessionId: "fallback" },
  );
  assert.deepEqual(
    sessionRef.resolveSessionRef(
      { sessionId: " primary-id " },
      { sessionFile: " /tmp/fallback.jsonl ", sessionId: "fallback" },
    ),
    { sessionFile: "/tmp/fallback.jsonl", sessionId: "primary-id" },
  );

  assert.equal(
    sessionRef.sessionRefMatches(
      { sessionFile: "/tmp/demo.jsonl", sessionId: "demo-session" },
      { sessionFile: " /tmp/demo.jsonl " },
    ),
    true,
  );
  assert.equal(
    sessionRef.sessionRefMatches(
      { sessionFile: "/tmp/demo.jsonl", sessionId: "demo-session" },
      { sessionFile: "/tmp/other.jsonl", sessionId: "demo-session" },
    ),
    false,
  );
  assert.equal(
    sessionRef.sessionRefMatches(
      { sessionFile: "/tmp/demo.jsonl", sessionId: "demo-session" },
      { sessionId: "other-session" },
    ),
    false,
  );

  assert.equal(
    sessionRef.readSessionFile({ sessionPath: " /tmp/legacy.jsonl " }),
    "/tmp/legacy.jsonl",
  );
  assert.equal(
    sessionRef.readSessionFile(" /tmp/direct.jsonl "),
    "/tmp/direct.jsonl",
  );
  assert.equal(
    sessionRef.readSessionFile({ sessionId: "memory-only" }),
    undefined,
  );
  assert.equal(
    sessionRef.requireSessionFile({ sessionFile: " /tmp/required.jsonl " }),
    "/tmp/required.jsonl",
  );
  assert.throws(
    () => sessionRef.requireSessionFile({ sessionId: "memory-only" }),
    /Session file is required/,
  );
});

test("session ref helpers store session files relative to agent sessions dir and resolve them back", () => {
  const agentDir = "/tmp/rin-agent";
  assert.equal(
    sessionRef.toStoredSessionFile(
      agentDir,
      "/tmp/rin-agent/sessions/chat/demo.jsonl",
    ),
    "chat/demo.jsonl",
  );
  assert.equal(
    sessionRef.toStoredSessionFile(agentDir, "chat\\demo.jsonl"),
    "chat/demo.jsonl",
  );
  assert.equal(
    sessionRef.toStoredSessionFile(agentDir, "./chat//nested/../demo.jsonl"),
    "chat/demo.jsonl",
  );
  assert.equal(
    sessionRef.toStoredSessionFile(agentDir, "/tmp/outside/demo.jsonl"),
    "/tmp/outside/demo.jsonl",
  );
  assert.equal(
    sessionRef.resolveStoredSessionFile(agentDir, "chat/demo.jsonl"),
    path.join(agentDir, "sessions", "chat", "demo.jsonl"),
  );
  assert.equal(
    sessionRef.resolveStoredSessionFile(
      agentDir,
      "./chat//nested/../demo.jsonl",
    ),
    path.join(agentDir, "sessions", "chat", "demo.jsonl"),
  );
  assert.equal(
    sessionRef.resolveStoredSessionFile(agentDir, "/tmp/outside/demo.jsonl"),
    "/tmp/outside/demo.jsonl",
  );
});
