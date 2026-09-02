import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const agentSdkModule = await importBuiltModule<
  typeof import("../../src/core/rin-agent-sdk/index.js")
>("dist/core/rin-agent-sdk/index.js");

async function withDaemonRecorder(
  run: (
    socketPath: string,
    commands: Array<Record<string, any>>,
  ) => Promise<void>,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-agent-sdk-owner-"),
  );
  const socketPath = path.join(directory, "daemon.sock");
  const commands: Array<Record<string, any>> = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        commands.push(command);
        socket.write(
          `${JSON.stringify({
            type: "response",
            command: command.type,
            id: command.id,
            success: true,
            data: { echoed: command },
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
    await run(socketPath, commands);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("Rin Agent SDK owns every daemon command shape and override path", async () => {
  await withDaemonRecorder(async (socketPath, commands) => {
    const sdk = agentSdkModule.createRinAgentSdk({
      socketPath,
      timeoutMs: 500,
    });
    const override = { socketPath, timeoutMs: 1_000 };

    await sdk.daemon.status();
    await sdk.daemon.activity(override);
    await sdk.sessions.list();
    await sdk.sessions.list({ limit: 7, offset: 2 }, override);

    await sdk.tasks.list();
    await sdk.tasks.reload();
    await sdk.tasks.get(" task-1 ");
    await sdk.tasks.upsert({ id: "task-2" }, { enabled: true });
    await sdk.tasks.delete("task-2");
    await sdk.tasks.complete("task-3");
    await sdk.tasks.complete("task-4", "owner-finished", override);
    await sdk.tasks.pause("task-5");
    await sdk.tasks.resume("task-6");
    await sdk.tasks.rescheduleOnce("task-7", "2026-07-17T00:00:00.000Z");
    await sdk.tasks.run("task-8");
    await sdk.tasks.wake("task-9");
    await sdk.tasks.control("pause", "task-10");
    await sdk.tasks.control("resume", "task-11", override);

    await sdk.chat.send({ chatKey: "telegram/1:2", text: "hello" });
    await sdk.chat.send({
      chatKey: "telegram/1:2",
      parts: [{ type: "text", text: "structured" }],
      metadata: "owner",
    });
    await sdk.chat.runTurn({ chatKey: "telegram/1:2", text: "run" });
    await sdk.chat.typing(" telegram/1:2 ");
    await sdk.chat.typing({ chatKey: "telegram/1:3" });
    await sdk.chat.react({
      chatKey: "telegram/1:2",
      messageId: "message-1",
      emoji: "👍",
    });
    await sdk.chat.terminateTurn("controller-1");
    await sdk.chat.terminateTurn({ chatKey: "telegram/1:2" });
    await sdk.chat.evalBridge(
      { code: "return 1", requestId: "eval-1" },
      override,
    );
    await sdk.chat.messages.get({
      chatKey: " telegram/1:2 ",
      messageId: " message-1 ",
    });
    await sdk.chat.messages.list({
      chatKey: " telegram/1:2 ",
      before: " before-1 ",
      after: " after-1 ",
      limit: 500,
    });
    await sdk.chat.messages.list({ chatKey: "telegram/1:2", limit: NaN });

    await sdk.nerve.emit({
      id: "stimulus-1",
      producer: "sdk-test",
      sensation: "test",
      body: "payload",
    });
    await sdk.nerve.status();
    await sdk.nerve.abort();
    await sdk.nerve.reloadTrigger("clock");

    assert.deepEqual(
      commands.map((command) => command.type),
      [
        "daemon_status",
        "daemon_activity",
        "list_sessions",
        "list_sessions",
        "cron_list_tasks",
        "cron_reload_tasks",
        "cron_get_task",
        "cron_upsert_task",
        "cron_delete_task",
        "cron_complete_task",
        "cron_complete_task",
        "cron_pause_task",
        "cron_resume_task",
        "cron_reschedule_once_task",
        "cron_run_task",
        "cron_wake_task",
        "cron_pause_task",
        "cron_resume_task",
        "chat_send",
        "chat_send",
        "chat_run_turn",
        "chat_typing",
        "chat_typing",
        "chat_react",
        "chat_terminate_turn",
        "chat_terminate_turn",
        "chat_bridge_eval",
        "chat_message_get",
        "chat_message_list",
        "chat_message_list",
        "nerve_emit",
        "nerve_status",
        "nerve_abort",
        "nerve_reload_trigger",
      ],
    );
    assert.deepEqual(commands[2], {
      type: "list_sessions",
      id: commands[2].id,
    });
    assert.equal(commands[3].limit, 7);
    assert.equal(commands[3].offset, 2);
    assert.equal(commands[6].taskId, "task-1");
    assert.equal(commands[9].reason, "completed_by_sdk");
    assert.equal(commands[10].reason, "owner-finished");
    assert.deepEqual(commands[18].payload.parts, [
      { type: "text", text: "hello" },
    ]);
    assert.deepEqual(commands[19].payload.parts, [
      { type: "text", text: "structured" },
    ]);
    assert.equal(commands[21].payload.chatKey, "telegram/1:2");
    assert.deepEqual(commands[24].payload, { controllerKey: "controller-1" });
    assert.deepEqual(commands[25].payload, { chatKey: "telegram/1:2" });
    assert.equal(
      commands.find((command) => command.type === "nerve_emit")?.payload
        .producer,
      "sdk-test",
    );
    assert.equal(
      commands.find((command) => command.type === "nerve_reload_trigger")
        ?.payload.id,
      "clock",
    );

    await assert.rejects(
      () => sdk.tasks.get("  "),
      /rin_agent_sdk_task_id_required/,
    );
    await assert.rejects(
      () => sdk.tasks.delete(""),
      /rin_agent_sdk_task_id_required/,
    );
    await assert.rejects(
      () => sdk.chat.messages.get({ chatKey: "", messageId: "message" }),
      /chat_message_store_chatKey_required/,
    );
    await assert.rejects(
      () => sdk.chat.messages.get({ chatKey: "chat", messageId: "" }),
      /chat_message_store_messageId_required/,
    );
    await assert.rejects(
      () => sdk.chat.messages.list({ chatKey: "" }),
      /chat_message_store_chatKey_required/,
    );
  });
});
