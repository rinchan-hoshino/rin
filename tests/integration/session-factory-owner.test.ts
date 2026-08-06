import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const factory = await importBuiltModule<
  typeof import("../../src/core/session/factory.js")
>("dist/core/session/factory.js");

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-factory-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("session factory opens a disposable configured session", async () => {
  await withTempRoot(async (root) => {
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "project");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    const configured = await factory.openBoundSession({
      cwd,
      agentDir,
      additionalExtensionPaths: [],
      disabledRinCapabilities: ["todo"],
      thinkingLevel: "low",
    });
    try {
      assert.ok(configured.session);
      assert.ok(configured.runtime);
      const reused = await factory.openBoundSession({
        cwd,
        agentDir,
        sessionManager: configured.session.sessionManager,
      });
      try {
        assert.equal(
          reused.session.sessionManager,
          configured.session.sessionManager,
        );
      } finally {
        await reused.session.abort().catch(() => {});
        await reused.runtime.dispose();
      }
    } finally {
      await configured.session.abort().catch(() => {});
      await configured.runtime.dispose();
    }
  });
});

test("session factory rejects a selected session file that no longer exists", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        factory.openBoundSession({
          cwd: root,
          agentDir: path.join(root, "agent"),
          sessionFile: path.join(root, "missing.jsonl"),
        }),
      /missing or expired|not found|ENOENT/i,
    );
  });
});

test("session factory lists exact sessions, normalizes failures, and routes pages", async () => {
  await withTempRoot(async (root) => {
    const listedCalls: Array<[string, string]> = [];
    const SessionManager = {
      async list(cwd: string, sessionDir: string) {
        listedCalls.push([cwd, sessionDir]);
        return [
          {
            id: "older",
            path: path.join(sessionDir, "older.jsonl"),
            modified: new Date("2026-01-01T00:00:00Z"),
          },
          {
            id: "newer",
            path: path.join(sessionDir, "newer.jsonl"),
            modified: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "duplicate",
            path: path.join(sessionDir, "newer.jsonl"),
            modified: new Date("2026-01-03T00:00:00Z"),
          },
        ];
      },
    };
    const sessions = await factory.listBoundSessions({
      cwd: root,
      agentDir: path.join(root, "agent"),
      sessionDir: root,
      SessionManager,
    });
    assert.deepEqual(
      sessions.map((entry: any) => entry.id),
      ["newer", "older"],
    );
    assert.deepEqual(listedCalls, [[root, root]]);

    const failed = await factory.listBoundSessions({
      cwd: root,
      sessionDir: root,
      SessionManager: { list: async () => Promise.reject(new Error("broken")) },
    });
    assert.deepEqual(failed, []);

    const page = await factory.listBoundSessions({
      cwd: root,
      sessionDir: root,
      limit: 3,
      offset: 2,
    });
    assert.deepEqual(page, []);
    assert.deepEqual(
      await factory.listBoundSessions({
        cwd: root,
        sessionDir: root,
        limit: 1,
      }),
      [],
    );
    assert.deepEqual(
      await factory.listBoundSessions({
        cwd: root,
        sessionDir: root,
        offset: 1,
      }),
      [],
    );
    assert.deepEqual(await factory.listBoundSessions(), []);
  });
});

test("session factory reads a bounded page and normalizes its records", async () => {
  await withTempRoot(async (root) => {
    const cwd = path.join(root, "project");
    await fs.mkdir(cwd);
    const write = async (name: string, id: string, timestamp: string) => {
      await fs.writeFile(
        path.join(root, name),
        [
          JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }),
          JSON.stringify({
            type: "message",
            id: `${id}-user`,
            timestamp,
            message: { role: "user", content: [{ type: "text", text: id }] },
          }),
        ].join("\n") + "\n",
      );
    };
    await write("a.jsonl", "a", "2026-01-01T00:00:00Z");
    await write("b.jsonl", "b", "2026-01-02T00:00:00Z");

    const page = await factory.listBoundSessionPage({
      cwd,
      sessionDir: root,
      limit: 1,
      offset: 0,
    });
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0]?.id, "b");
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 1);
  });
});

test("session factory uses runtime profile defaults for an empty page", async () => {
  const page = await factory.listBoundSessionPage();
  assert.deepEqual(page.sessions, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
});

test("session factory renames through the selected manager and validates input", async () => {
  const calls: unknown[] = [];
  const manager = {
    sessionFile: "/tmp/renamed.jsonl",
    fileEntries: [],
    isPersisted: () => false,
    appendSessionInfo(name: string) {
      calls.push(["append", name]);
    },
  };
  const SessionManager = {
    open(file: string) {
      calls.push(["open", file]);
      return manager;
    },
  };

  await factory.renameBoundSession(" /tmp/renamed.jsonl ", "  Focus  ", {
    SessionManager,
  });
  assert.deepEqual(calls, [
    ["open", "/tmp/renamed.jsonl"],
    ["append", "Focus"],
  ]);
  await assert.rejects(
    () =>
      factory.renameBoundSession("/tmp/renamed.jsonl", "  ", {
        SessionManager,
      }),
    /cannot be empty/i,
  );
  await assert.rejects(
    () => factory.renameBoundSession("", "name", { SessionManager }),
    /session file/i,
  );
});

test("session factory renames a persisted session with the default manager", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = path.join(root, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "rename-default",
        timestamp: "2026-01-01T00:00:00Z",
        cwd: root,
      })}\n`,
    );
    await factory.renameBoundSession(sessionFile, "Default manager");
    assert.match(await fs.readFile(sessionFile, "utf8"), /Default manager/);
  });
});
