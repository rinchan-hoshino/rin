import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";
import { createSocketTestSandbox } from "../support/socket-test-sandbox.js";

const socketSandbox = createSocketTestSandbox("tasks-owner");
after(() => socketSandbox.cleanup());

const tasks = await importBuiltModule<
  typeof import("../../src/core/rin/tasks.js")
>("dist/core/rin/tasks.js");
const shared = await importBuiltModule<
  typeof import("../../src/core/rin/shared.js")
>("dist/core/rin/shared.js");

function parsed(installDir: string) {
  return {
    command: "tasks",
    targetUser: os.userInfo().username,
    targetName: "",
    installDir,
    passthrough: [],
    explicitUser: true,
    explicitTarget: false,
    hasSavedInstall: true,
    releaseChannel: "stable",
    releaseBranch: "",
    releaseVersion: "",
    explicitReleaseChannel: false,
    updateAssumeYes: false,
  } as any;
}

async function captureLogs(run: () => Promise<void>) {
  const logs: string[] = [];
  const log = mock.method(console, "log", (...args) =>
    logs.push(args.join(" ")),
  );
  try {
    await run();
  } finally {
    log.mock.restore();
  }
  return logs;
}

async function withDaemon(
  socketPath: string,
  run: () => Promise<void>,
  responseData: unknown = {
    cron: {
      taskCount: 3,
      enabledTaskCount: 2,
      nextRunAt: "2026-07-16T03:04:05.000Z",
    },
  },
) {
  socketSandbox.assertOwnedSocketPath(socketPath);
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await socketSandbox.removeOwnedSocket(socketPath);
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.write(
        JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
          data: responseData,
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await socketSandbox.removeOwnedSocket(socketPath);
  }
}

test("tasks parser accepts one reload action and rejects ambiguous syntax", () => {
  assert.deepEqual(tasks.parseTasksArgs(["tasks"]), {
    action: "",
    json: false,
    help: true,
  });
  assert.deepEqual(
    tasks.parseTasksArgs(["-u", "rin", "tasks", "reload", "--json"]),
    {
      action: "reload",
      json: true,
      help: false,
    },
  );
  assert.deepEqual(tasks.parseTasksArgs(["tasks", "-h"]), {
    action: "",
    json: false,
    help: true,
  });
  assert.throws(
    () => tasks.parseTasksArgs(["tasks", "reload", "reload"]),
    /unknown_tasks_arg:reload/,
  );
  assert.throws(
    () => tasks.parseTasksArgs(["tasks", "--bad"]),
    /unknown_tasks_arg:--bad/,
  );
});

test("tasks help and unavailable daemon responses are explicit in text and JSON", async () => {
  const help = await captureLogs(() =>
    tasks.runTasksInternal(["tasks", "--help"]),
  );
  assert.match(help[0], /rin tasks <command>/);

  const unavailableText = await captureLogs(() =>
    tasks.runTasksInternal(["tasks", "reload"]),
  );
  assert.deepEqual(unavailableText, ["Rin daemon is unavailable."]);
  const unavailableJson = await captureLogs(() =>
    tasks.runTasksInternal(["tasks", "reload", "--json"]),
  );
  assert.deepEqual(JSON.parse(unavailableJson[0]), {
    error: "rin_daemon_unavailable",
  });
});

test("tasks reload uses the selected target socket and formats daemon results", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-tasks-owner-"),
  );
  try {
    const args = parsed(installDir);
    const socketPath = shared.createTargetExecutionContext(args).socketPath;
    await withDaemon(socketPath, async () => {
      const text = await captureLogs(() =>
        tasks.runTasks(args, ["tasks", "reload"]),
      );
      assert.equal(text.length, 1);
      assert.match(
        text[0],
        /Scheduled tasks reloaded: 3 tasks, 2 enabled, next/,
      );

      const json = await captureLogs(() =>
        tasks.runTasks(args, ["tasks", "reload", "--json"]),
      );
      assert.equal(JSON.parse(json[0]).cron.taskCount, 3);
    });
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("tasks reload normalizes incomplete daemon reports", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-tasks-empty-"),
  );
  try {
    const args = parsed(installDir);
    const socketPath = shared.createTargetExecutionContext(args).socketPath;
    await withDaemon(
      socketPath,
      async () => {
        const lines = await captureLogs(() =>
          tasks.runTasks(args, ["tasks", "reload"]),
        );
        assert.match(lines[0], /0 tasks, 0 enabled, next -/);
      },
      {},
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("tasks selected target reports unavailable daemon and handles help first", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-tasks-unavailable-"),
  );
  try {
    const args = parsed(installDir);
    const help = await captureLogs(() =>
      tasks.runTasks(args, ["tasks", "--help"]),
    );
    assert.match(help[0], /reload scheduled task records/);
    const unavailable = await captureLogs(() =>
      tasks.runTasks(args, ["tasks", "reload", "--json"]),
    );
    assert.deepEqual(JSON.parse(unavailable[0]), {
      error: "rin_daemon_unavailable",
    });
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("tasks forwards cross-user reload through the internal command", async () => {
  const captures: any[][] = [];
  const exec = mock.method(childProcess, "execFileSync", (...args: any[]) => {
    captures.push(args);
    return "forwarded tasks\n";
  });
  const writes: string[] = [];
  const write = mock.method(process.stdout, "write", (value: any) => {
    writes.push(String(value));
    return true;
  });
  syncBuiltinESMExports();
  try {
    await tasks.runTasks({ ...parsed("/srv/rin"), targetUser: "nobody" }, [
      "--user",
      "nobody",
      "tasks",
      "reload",
    ]);
  } finally {
    exec.mock.restore();
    syncBuiltinESMExports();
    write.mock.restore();
  }

  assert.ok(captures.length >= 1);
  assert.match(JSON.stringify(captures), /__tasks_internal/);
  assert.deepEqual(writes, ["forwarded tasks\n"]);
});
