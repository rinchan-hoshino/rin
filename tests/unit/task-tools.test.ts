import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const taskIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "task", "index.js")).href
);

function getTaskTool(name) {
  const tools = [];
  taskIndex.default({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

function emptySessionContext() {
  return {
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
      getSessionName: () => undefined,
    },
  };
}

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function withTaskDaemon(dataForPayload, run, options = {}) {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-task-runtime-"),
  );
  const socketDir = path.join(
    runtimeDir,
    options.socketDirName || "rin-daemon",
  );
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: dataForPayload(payload, requests),
          })}\n`,
        );
      }
    });
  });

  const envUpdates = { RIN_DAEMON_SOCKET_PATH: socketPath };
  const envNames = new Set([
    ...Object.keys(envUpdates),
    ...(options.restoreEnv || []),
  ]);
  const previousEnv = Object.fromEntries(
    Array.from(envNames).map((name) => [name, process.env[name]]),
  );

  try {
    await listen(server, socketPath);
    for (const [name, value] of Object.entries(envUpdates)) {
      restoreEnvValue(name, value);
    }
    await run({ requests, runtimeDir, socketPath });
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      restoreEnvValue(name, value);
    }
    await closeServer(server);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

test("save_task exposes none/dedicated session modes, model and prompt options", () => {
  const saveTool = getTaskTool("save_task");
  assert.equal(saveTool.parameters.properties.id.type, "string");
  assert.equal(saveTool.parameters.properties.model.type, "string");
  assert.ok(saveTool.parameters.properties.thinkingLevel);
  assert.equal(
    saveTool.parameters.properties.session.properties.sessionFile,
    undefined,
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.mode.description || "",
    ),
    /none/,
  );
  assert.match(
    String(
      saveTool.parameters.properties.session.properties.mode.description || "",
    ),
    /dedicated/,
  );
  assert.ok(
    saveTool.parameters.properties.target.properties.continuationPrompt,
  );
});

test("get_task returns a requested task instead of falling back to 'No scheduled tasks'", async () => {
  await withTaskDaemon(
    () => ({
      task: {
        id: "cron_demo",
        name: "Demo Task",
        enabled: true,
        trigger: { intervalMs: 60_000 },
        session: { mode: "dedicated" },
        target: { kind: "agent_prompt", prompt: "hello" },
        nextRunAt: "2026-04-18T00:00:00.000Z",
      },
    }),
    async () => {
      const getTool = getTaskTool("get_task");
      const result = await getTool.execute(
        "tool-1",
        { taskId: "cron_demo" },
        undefined,
        undefined,
        emptySessionContext(),
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /cron_demo \(Demo Task\)/);
      assert.doesNotMatch(text, /No scheduled tasks\./);
    },
  );
});

test("get_task respects RIN_DAEMON_SOCKET_PATH over legacy runtime dir lookup", async () => {
  await withTaskDaemon(
    () => ({
      task: {
        id: "cron_env_socket",
        enabled: true,
        trigger: { runAt: "2026-04-18T00:00:00.000Z" },
        session: { mode: "dedicated" },
        target: { kind: "agent_prompt", prompt: "hello" },
        nextRunAt: "2026-04-18T00:00:00.000Z",
      },
    }),
    async ({ runtimeDir }) => {
      process.env.XDG_RUNTIME_DIR = path.join(runtimeDir, "wrong-runtime-dir");
      const getTool = getTaskTool("get_task");
      const result = await getTool.execute(
        "tool-explicit-socket",
        { taskId: "cron_env_socket" },
        undefined,
        undefined,
        emptySessionContext(),
      );
      assert.match(String(result.content?.[0]?.text || ""), /cron_env_socket/);
    },
    { socketDirName: "explicit-daemon", restoreEnv: ["XDG_RUNTIME_DIR"] },
  );
});

test("get_task without taskId lists scheduled tasks via cron_list_tasks", async () => {
  await withTaskDaemon(
    () => ({
      tasks: [
        {
          id: "cron_alpha",
          enabled: true,
          trigger: { runAt: "2026-04-18T00:00:00.000Z" },
          session: { mode: "dedicated" },
          target: { kind: "agent_prompt", prompt: "alpha" },
          nextRunAt: "2026-04-18T00:00:00.000Z",
        },
        {
          id: "cron_beta",
          name: "Beta Task",
          enabled: false,
          trigger: { expression: "0 * * * *" },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "echo beta" },
        },
      ],
    }),
    async ({ requests }) => {
      const getTool = getTaskTool("get_task");
      const result = await getTool.execute(
        "tool-2",
        {},
        undefined,
        undefined,
        emptySessionContext(),
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0].type, "cron_list_tasks");
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /cron_alpha/);
      assert.match(text, /cron_beta \(Beta Task\)/);
      assert.match(text, /disabled/);
      assert.doesNotMatch(text, /No scheduled tasks\./);
    },
  );
});

test("save_task only auto-binds valid current chat session names", async () => {
  await withTaskDaemon(
    (payload) => ({ task: payload.task }),
    async ({ requests }) => {
      const saveTool = getTaskTool("save_task");
      await saveTool.execute(
        "tool-invalid",
        {
          trigger: { runAt: "2026-04-18T00:00:00.000Z" },
          target: { kind: "agent_prompt", prompt: "hello" },
        },
        undefined,
        undefined,
        {
          sessionManager: {
            getSessionFile: () => undefined,
            getSessionId: () => undefined,
            getSessionName: () => "telegram:1",
          },
        },
      );
      await saveTool.execute(
        "tool-valid",
        {
          trigger: { runAt: "2026-04-18T00:00:00.000Z" },
          target: { kind: "agent_prompt", prompt: "hello" },
        },
        undefined,
        undefined,
        {
          sessionManager: {
            getSessionFile: () => undefined,
            getSessionId: () => undefined,
            getSessionName: () => "telegram/777:1",
          },
        },
      );

      assert.equal(requests.length, 2);
      assert.equal(requests[0].type, "cron_upsert_task");
      assert.equal(requests[0].defaults?.chatKey, undefined);
      assert.equal(requests[0].task?.chatKey, undefined);
      assert.equal(requests[1].defaults?.chatKey, "telegram/777:1");
      assert.equal(requests[1].task?.chatKey, "telegram/777:1");
    },
  );
});

test("save_task normalizes prompt and shell targets before sending them to the daemon", async () => {
  await withTaskDaemon(
    (payload) => ({ task: payload.task }),
    async ({ requests }) => {
      const saveTool = getTaskTool("save_task");
      await saveTool.execute(
        "tool-agent",
        {
          trigger: { runAt: "2026-04-18T00:00:00.000Z" },
          target: { kind: "agent_prompt", prompt: "  hello world  " },
        },
        undefined,
        undefined,
        {},
      );
      await saveTool.execute(
        "tool-shell",
        {
          chatKey: null,
          trigger: { runAt: "2026-04-18T00:00:00.000Z" },
          session: { mode: "none" },
          target: { kind: "shell_command", command: "echo hello" },
        },
        undefined,
        undefined,
        {},
      );

      assert.equal(requests.length, 2);
      assert.equal(requests[0].task?.session?.mode, "none");
      assert.equal(requests[0].task?.target?.kind, "agent_prompt");
      assert.equal(requests[0].task?.target?.prompt, "hello world");
      assert.equal(requests[1].task?.chatKey, null);
      assert.equal(requests[1].task?.session?.mode, "none");
      assert.equal(requests[1].task?.session?.sessionFile, undefined);
      assert.equal(requests[1].task?.target?.kind, "shell_command");
      assert.equal(requests[1].task?.target?.command, "echo hello");
    },
  );
});

test("manage_task maps public actions to daemon task commands", async () => {
  await withTaskDaemon(
    (payload) =>
      payload.type === "cron_delete_task"
        ? { deleted: true }
        : {
            task: {
              id: payload.taskId,
              enabled: payload.type === "cron_resume_task",
              trigger: { runAt: "2026-04-18T00:00:00.000Z" },
              session: { mode: "dedicated" },
              target: { kind: "agent_prompt", prompt: "hello" },
              nextRunAt: "2026-04-18T00:00:00.000Z",
            },
          },
    async ({ requests }) => {
      const manageTool = getTaskTool("manage_task");
      const deleted = await manageTool.execute(
        "tool-delete",
        { action: "delete", taskId: "cron_demo" },
        undefined,
        undefined,
        {},
      );
      const paused = await manageTool.execute(
        "tool-pause",
        { action: "pause", taskId: "cron_demo" },
        undefined,
        undefined,
        {},
      );
      const resumed = await manageTool.execute(
        "tool-resume",
        { action: "resume", taskId: "cron_demo" },
        undefined,
        undefined,
        {},
      );

      assert.deepEqual(
        requests.map((request) => request.type),
        ["cron_delete_task", "cron_pause_task", "cron_resume_task"],
      );
      assert.match(
        String(deleted.content?.[0]?.text || ""),
        /Deleted task: cron_demo/,
      );
      assert.match(String(paused.content?.[0]?.text || ""), /disabled/);
      assert.match(
        String(resumed.content?.[0]?.text || ""),
        /next=2026-04-18T00:00:00.000Z/,
      );
    },
  );
});
