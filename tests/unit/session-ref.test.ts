import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const sessionRef = await importBuiltModule<
  typeof import("../../src/core/session/ref.js")
>("dist/core/session/ref.js");

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

test("session ref helpers reject empty values and require existing records", async () => {
  assert.equal(sessionRef.normalizeSessionValue(undefined), undefined);
  assert.equal(sessionRef.resolveSessionValue(" ", " fallback "), "fallback");
  assert.equal(
    sessionRef.toStoredSessionFile("/tmp/rin-agent", " "),
    undefined,
  );
  assert.equal(
    sessionRef.toStoredSessionFile("/tmp/rin-agent", "."),
    undefined,
  );
  assert.equal(
    sessionRef.resolveStoredSessionFile("/tmp/rin-agent", " "),
    undefined,
  );
  assert.equal(
    sessionRef.resolveStoredSessionFile("/tmp/rin-agent", "."),
    undefined,
  );
  assert.deepEqual(sessionRef.normalizeSessionRef(null), {
    sessionId: undefined,
    sessionFile: undefined,
  });
  assert.equal(sessionRef.sessionRefMatches({}, {}), false);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-session-ref-"));
  const sessionFile = path.join(tempDir, "session.jsonl");
  await fs.writeFile(sessionFile, "{}\n");
  try {
    assert.equal(sessionRef.sessionFileExists(sessionFile), true);
    assert.equal(sessionRef.sessionFileExists(" "), false);
    assert.equal(
      sessionRef.requireExistingSessionFile(sessionFile),
      sessionFile,
    );
    assert.throws(
      () => sessionRef.requireExistingSessionFile(path.join(tempDir, "gone")),
      /Session record is missing or expired: .*gone/,
    );
    assert.match(
      sessionRef.missingSessionFileError(undefined).message,
      /the selected session/,
    );
    assert.throws(
      () => sessionRef.requireSessionFile(undefined, "choose a session"),
      /choose a session/,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
