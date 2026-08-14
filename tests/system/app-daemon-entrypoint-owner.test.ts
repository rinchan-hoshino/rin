import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin-daemon/daemon.js");
const entrypointSource = path.resolve("src/app/rin-daemon/daemon.ts");
const registerFixture = path.resolve(
  "tests/support/register-app-daemon-owner-fixture.ts",
);

async function runDaemon(
  root: string,
  mode: "success" | "daemon-fail" | "lock-fail" | "services-fail",
  socketPath = "",
) {
  const sandbox = await createTestSandbox(root);
  return await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      registerFixture,
      entrypoint,
      ...(socketPath ? [socketPath] : []),
    ],
    {
      env: { ...sandbox.env, RIN_TEST_APP_DAEMON_MODE: mode },
    },
  );
}

test("app daemon entrypoint only assembles the typed Chat integration", async () => {
  const source = await fs.readFile(entrypointSource, "utf8");
  assert.match(source, /createChatDaemonIntegration/);
  assert.match(
    source,
    /additionalCommandRouter:\s*chatIntegration\.commandRouter/,
  );
  assert.doesNotMatch(source, /handleLocalCommand/);
  assert.doesNotMatch(
    source,
    /chat_(?:send|run_turn|typing|react|terminate_turn|message_get|message_list|bridge_eval)/,
  );
  assert.doesNotMatch(source, /command\?\.type|command\.type/);
});

test("app daemon assembles hosted services and failure cleanup", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-app-daemon-owner-"),
  );
  try {
    const success = await runDaemon(root, "success", "/owner/explicit.sock");
    const summary = JSON.parse(success.stdout.trim().split("\n").at(-1)!);
    assert.equal(summary.socketPath, "/owner/explicit.sock");
    assert.deepEqual(summary.starting, {
      chat: { ready: false, status: "starting" },
    });
    assert.deepEqual(summary.ready, {
      chat: { status: "ready", owner: true },
    });
    assert.deepEqual(summary.routed, {
      data: { routed: { owner: true } },
    });
    assert.equal(summary.unknown, null);
    assert.deepEqual(summary.extensionApi, { ownerExtensionApi: true });
    const daemonStart = summary.events.find(
      (event: unknown[]) => event[0] === "daemon-start",
    );
    assert.ok(daemonStart);
    assert.match(daemonStart[2], /\/rin-daemon\/worker\.js$/);
    assert.match(daemonStart[3], /\/rin-daemon\/self-improve-worker\.js$/);
    const chatApiIndex = summary.events.findIndex(
      (event: unknown[]) => event[0] === "manager-chat-api",
    );
    const managerStartIndex = summary.events.findIndex(
      (event: unknown[]) => event[0] === "manager-start",
    );
    assert.ok(chatApiIndex >= 0);
    assert.ok(managerStartIndex > chatApiIndex);
    assert.deepEqual(summary.events[managerStartIndex], [
      "manager-start",
      true,
    ]);
    assert.match(success.stderr, /owner cgroup warning/);

    const defaultSocket = await runDaemon(root, "success");
    assert.equal(
      JSON.parse(defaultSocket.stdout.trim().split("\n").at(-1)!).socketPath,
      "/owner/default-daemon.sock",
    );

    for (const [mode, message] of [
      ["lock-fail", "formatted:owner lock failed"],
    ] as const) {
      await assert.rejects(
        () => runDaemon(root, mode),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, new RegExp(message));
          return true;
        },
      );
    }

    await assert.rejects(
      () => runDaemon(root, "services-fail"),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /rin_app_daemon_chat_degraded:owner hosted services failed/,
        );
        assert.match(
          error.stderr,
          /formatted:chat_bridge_unavailable:owner hosted services failed/,
        );
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
