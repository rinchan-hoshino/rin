import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import taskCapability from "../../src/core/task/index.ts";
import { createRinAgentSdk } from "../../src/core/rin-agent-sdk/index.ts";

function getTaskTools() {
  return taskCapability().tools || [];
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

async function withDaemon(dataForPayload, run) {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-agent-sdk-runtime-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
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

  try {
    await listen(server, socketPath);
    await run({ requests, socketPath });
  } finally {
    await closeServer(server);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

test("task capability no longer exposes model task tools", () => {
  assert.deepEqual(
    getTaskTools().map((tool) => tool.name),
    [],
  );
});

test("agent SDK maps task helpers to daemon task commands", async () => {
  await withDaemon(
    (payload) => ({
      task: {
        id: payload.taskId,
        name: "Demo Task",
        enabled: payload.type === "cron_resume_task",
      },
    }),
    async ({ requests, socketPath }) => {
      const rin = createRinAgentSdk({ socketPath });
      const paused = await rin.tasks.pause("cron_demo");
      const resumed = await rin.tasks.resume("cron_demo");
      await rin.tasks.run("cron_demo");
      await rin.tasks.wake("cron_demo");
      await rin.tasks.rescheduleOnce("cron_demo", "2099-01-02T00:00:00.000Z");
      await rin.tasks.get("cron_demo");
      await rin.tasks.list();
      await rin.tasks.upsert({ id: "cron_demo" });
      await rin.tasks.complete("cron_demo", "done");
      await rin.tasks.delete("cron_demo");

      assert.deepEqual(
        requests.map((request) => request.type),
        [
          "cron_pause_task",
          "cron_resume_task",
          "cron_run_task",
          "cron_wake_task",
          "cron_reschedule_once_task",
          "cron_get_task",
          "cron_list_tasks",
          "cron_upsert_task",
          "cron_complete_task",
          "cron_delete_task",
        ],
      );
      assert.equal(paused.task.id, "cron_demo");
      assert.equal(paused.task.enabled, false);
      assert.equal(resumed.task.enabled, true);
    },
  );
});

test("agent SDK maps chat helpers to daemon chat commands", async () => {
  await withDaemon(
    (payload) => {
      if (payload.type === "chat_send") return { delivered: true };
      if (payload.type === "chat_run_turn") return { finalText: "ok" };
      if (payload.type === "chat_terminate_turn") return { terminated: true };
      return { ok: true };
    },
    async ({ requests, socketPath }) => {
      const rin = createRinAgentSdk({ socketPath });
      await rin.chat.send({ chatKey: "telegram/1:2", text: "hello" });
      const turn = await rin.chat.runTurn({
        chatKey: "telegram/1:2",
        text: "reply",
        controllerKey: "agent-test",
      });
      const terminated = await rin.chat.terminateTurn("agent-test");
      const terminatedChat = await rin.chat.terminateTurn({
        chatKey: "telegram/1:3",
      });
      await rin.chat.evalBridge({ code: "return 1;" });

      assert.deepEqual(
        requests.map((request) => request.type),
        [
          "chat_send",
          "chat_run_turn",
          "chat_terminate_turn",
          "chat_terminate_turn",
          "chat_bridge_eval",
        ],
      );
      assert.deepEqual(requests[0].payload, {
        chatKey: "telegram/1:2",
        text: "hello",
      });
      assert.deepEqual(requests[2].payload, { controllerKey: "agent-test" });
      assert.deepEqual(requests[3].payload, {
        chatKey: "telegram/1:3",
      });
      assert.equal(turn.finalText, "ok");
      assert.equal(terminated.terminated, true);
      assert.equal(terminatedChat.terminated, true);
    },
  );
});
