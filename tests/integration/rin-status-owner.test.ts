import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const status = await importBuiltModule<
  typeof import("../../src/core/rin/status.js")
>("dist/core/rin/status.js");

type DaemonHandler = (
  request: any,
) => { success?: boolean; data?: unknown; error?: string } | undefined;

function parsed() {
  return {
    command: "status",
    targetUser: os.userInfo().username,
    targetName: "",
    installDir: "/tmp/rin-status-owner-install",
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

async function captureOutput(run: () => Promise<unknown>) {
  const lines: string[] = [];
  const chunks: string[] = [];
  const log = mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const write = mock.method(process.stdout, "write", ((value: unknown) => {
    chunks.push(String(value));
    return true;
  }) as any);
  try {
    await run();
  } finally {
    log.mock.restore();
    write.mock.restore();
  }
  return { lines, chunks };
}

async function withDaemon(
  socketPath: string,
  handler: DaemonHandler,
  run: () => Promise<void>,
) {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.rm(socketPath, { force: true });
  const requests: any[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        const result = handler(request) ?? {};
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: request.id,
            command: request.type,
            success: result.success !== false,
            ...(result.success === false
              ? { error: result.error || "owner daemon failure" }
              : { data: result.data }),
          })}\n`,
        );
      }
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
    await fs.rm(socketPath, { force: true });
  }
  return requests;
}

const activity = {
  generatedAt: "2026-07-17T08:09:10.000Z",
  socketPath: "/tmp/owner.sock",
  workerCount: 5,
  workers: [
    {
      id: "worker-working",
      pid: 101,
      state: "working",
      turnActive: true,
      isStreaming: true,
      isCompacting: true,
      rinWorking: true,
      attachedConnections: 2,
      pendingResponses: 3,
      idleSince: Date.now() - 65_000,
      sessionFile: "/home/owner/.rin/sessions/working.jsonl",
    },
    {
      id: "worker-compacting",
      pid: 102,
      state: "compacting",
      idleSince: Date.now() - 3_661_000,
      sessionId: "C:\\sessions\\fallback.jsonl",
    },
    { id: "worker-stopping", state: "stopping" },
    { id: "worker-idle", state: "idle" },
    { id: "worker-attached" },
  ],
  cron: {
    runningTaskCount: 1,
    enabledTaskCount: 2,
    nextRunAt: "2026-07-17T09:00:00.000Z",
    tasks: [
      {
        id: "task-running",
        name: "Running owner task",
        running: true,
        enabled: true,
        activeDurationMs: 3_000,
        runCount: 4,
        nextRunAt: "2026-07-17T09:00:00.000Z",
        lastFinishedAt: "2026-07-17T07:00:00.000Z",
        target: { kind: "agent_prompt" },
        session: { mode: "dedicated" },
      },
      {
        id: "task-enabled",
        enabled: true,
        targetKind: "chat_send",
        lastStartedAt: "2026-07-17T06:00:00.000Z",
      },
      {
        id: "task-completed",
        enabled: true,
        completedAt: "2026-07-17T05:00:00.000Z",
      },
    ],
  },
};

test("status parser preserves option order and rejects every malformed value", () => {
  assert.deepEqual(status.parseStatusArgs(["status"]), {
    watch: true,
    once: false,
    intervalMs: 1000,
    json: false,
    limit: 50,
    offset: 0,
    help: false,
  });
  assert.deepEqual(
    status.parseStatusArgs([
      "--user=owner",
      "status",
      "--once",
      "-w",
      "--interval",
      "0.001",
      "--limit=0",
      "--offset",
      "2.6",
      "-h",
    ]),
    {
      watch: true,
      once: false,
      intervalMs: 100,
      json: false,
      limit: 1,
      offset: 3,
      help: true,
    },
  );
  assert.deepEqual(
    status.parseStatusArgs([
      "status",
      "--watch",
      "--json",
      "--limit",
      "7.6",
      "--offset=4.4",
      "--interval=2.5",
    ]),
    {
      watch: false,
      once: true,
      intervalMs: 2500,
      json: true,
      limit: 8,
      offset: 4,
      help: false,
    },
  );

  for (const [argv, message] of [
    [["status", "--limit"], "missing_status_limit"],
    [["status", "--limit", "--json"], "missing_status_limit"],
    [["status", "--limit=nope"], "invalid_status_limit:nope"],
    [["status", "--offset"], "missing_status_offset"],
    [["status", "--offset", "--json"], "missing_status_offset"],
    [["status", "--offset=-1"], "invalid_status_offset:-1"],
    [["status", "--interval"], "missing_status_interval"],
    [["status", "--interval", "--json"], "missing_status_interval"],
    [["status", "--interval=0"], "invalid_status_interval:0"],
    [["status", "--interval=soon"], "invalid_status_interval:soon"],
    [["status", "--unknown"], "unknown_status_arg:--unknown"],
  ] as const) {
    assert.throws(() => status.parseStatusArgs([...argv]), new RegExp(message));
  }
});

test("status rendering orders activity and handles bounded and empty layouts", () => {
  assert.equal(
    status.renderStatusReport(null),
    "Rin session status: unavailable",
  );
  const report = status.renderStatusReport(activity);
  assert.match(report, /Rin Status/);
  assert.match(report, /workers 3\/5/);
  assert.match(report, /tasks 1\/2 running\/enabled/);
  assert.match(report, /worker-working/);
  assert.match(report, /Running owner task/);
  assert.match(report, /Details/);
  assert.match(report, /flags\s+turn, stream, compact, rin/);
  assert.match(report, /sessions\/working\.jsonl/);

  const selectedTask = status.renderStatusTui(
    activity,
    { selectedIndex: 99, expanded: true },
    { width: 70, height: 16, interactive: true },
  );
  assert.match(selectedTask, /↑\/↓ j\/k move/);
  assert.match(selectedTask, /task\s+task-completed/);
  assert.match(selectedTask, /state\s+stopped/);
  assert.doesNotMatch(selectedTask, /Details/);

  const enabledTask = status.renderStatusTui(
    activity,
    { selectedIndex: 6 },
    { width: 500, height: 18, interactive: false },
  );
  assert.match(enabledTask, /task-enabled/);
  assert.match(enabledTask, /chat_send/);

  const manyWorkers = {
    ...activity,
    workers: Array.from({ length: 24 }, (_, index) => ({
      id: `worker-${String(index).padStart(2, "0")}`,
      state: index % 2 ? "idle" : "working",
      pid: index,
    })),
    cron: { tasks: [] },
  };
  const viewport = status.renderStatusTui(
    manyWorkers,
    { selectedIndex: 20 },
    { width: 60, height: 16, interactive: true },
  );
  assert.match(viewport, /worker-20/);
  assert.doesNotMatch(viewport, /worker-00/);
  assert.ok(viewport.split("\n").every((line) => line.length <= 60));

  const empty = status.renderStatusTui(
    { generatedAt: "", workers: [], cron: {} },
    {},
    { width: 60, height: 16 },
  );
  assert.match(empty, /no workers or scheduled tasks/);
  assert.match(empty, /select a row for details/);
});

test("status internal command covers help, unavailable, text, JSON, and request failure", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-status-internal-owner-"),
  );
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  try {
    const help = await captureOutput(() =>
      status.runStatusInternal(["status", "--help"]),
    );
    assert.match(help.lines[0], /rin status \[options\]/);

    const unavailableText = await captureOutput(() =>
      status.runStatusInternal(["status", "--once"]),
    );
    assert.deepEqual(unavailableText.lines, ["Rin daemon status: unavailable"]);
    const unavailableJson = await captureOutput(() =>
      status.runStatusInternal(["status", "--json"]),
    );
    assert.deepEqual(JSON.parse(unavailableJson.lines[0]), {
      error: "rin_daemon_unavailable",
    });

    const requests = await withDaemon(
      socketPath,
      (request) => ({
        data:
          request.type === "daemon_activity"
            ? activity
            : { sessions: [{ id: "session-owner" }], total: 1 },
      }),
      async () => {
        const text = await captureOutput(() =>
          status.runStatusInternal(["status", "--once"]),
        );
        assert.match(text.lines[0], /worker-working/);

        const json = await captureOutput(() =>
          status.runStatusInternal([
            "status",
            "--json",
            "--limit=3",
            "--offset=2",
          ]),
        );
        const backend = JSON.parse(json.lines[0]);
        assert.equal(backend.schemaVersion, 1);
        assert.equal(backend.activity.workerCount, 5);
        assert.deepEqual(backend.sessions.sessions, [{ id: "session-owner" }]);
        assert.match(backend.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      },
    );
    assert.deepEqual(
      requests
        .filter((request) => request.type === "list_sessions")
        .map(({ limit, offset }) => ({ limit, offset })),
      [{ limit: 3, offset: 2 }],
    );

    await withDaemon(
      socketPath,
      () => ({ success: false, error: "owner request rejected" }),
      async () => {
        const text = await captureOutput(() =>
          status.runStatusInternal(["status", "--once"]),
        );
        assert.deepEqual(text.lines, [
          "Rin daemon status: unavailable (owner request rejected)",
        ]);
        const json = await captureOutput(() =>
          status.runStatusInternal(["status", "--json"]),
        );
        assert.deepEqual(JSON.parse(json.lines[0]), {
          error: "Rin daemon status: unavailable (owner request rejected)",
        });
      },
    );
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("target status command uses its selected socket and non-TTY snapshot path", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-status-target-owner-"),
  );
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  try {
    const help = await captureOutput(() =>
      status.runStatus(parsed(), ["status", "--help"]),
    );
    assert.match(help.lines[0], /Default view:/);

    const unavailable = await captureOutput(() =>
      status.runStatus(parsed(), ["status", "--once"]),
    );
    assert.deepEqual(unavailable.lines, ["Rin daemon status: unavailable"]);

    const requests = await withDaemon(
      socketPath,
      (request) => ({
        data:
          request.type === "daemon_activity"
            ? activity
            : { sessions: [], total: 0 },
      }),
      async () => {
        const once = await captureOutput(() =>
          status.runStatus(parsed(), ["status", "--once"]),
        );
        assert.match(once.lines[0], /workers 3\/5/);

        const fallback = await captureOutput(() =>
          status.runStatus(parsed(), ["status", "--interval=0.001"]),
        );
        assert.match(fallback.lines[0], /snapshot view/);

        const json = await captureOutput(() =>
          status.runStatus(parsed(), ["status", "--json"]),
        );
        assert.equal(JSON.parse(json.lines[0]).sessions.total, 0);
      },
    );
    assert.ok(
      requests.filter((request) => request.type === "daemon_activity").length >=
        3,
    );
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
