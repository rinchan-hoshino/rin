import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const boot = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "boot.js")).href
);

test("chat boot exposes the dedicated chat command registry", () => {
  const rows = boot.getChatCommandRows();
  assert.equal(rows[0].name, "help");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["help", "abort", "new", "compact", "reload", "status", "session", "model"],
  );
  assert.ok(!rows.some((row) => row.name === "init"));
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-boot-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("chat boot clears common telegram scopes before syncing default commands", async () => {
  const deletes = [];
  const sets = [];
  const bot = {
    platform: "telegram",
    selfId: "bot-1",
    internal: {
      async deleteMyCommands(payload) {
        deletes.push(payload);
      },
      async setMyCommands(payload) {
        sets.push(payload);
      },
    },
  };

  const rows = boot.getChatCommandRows();
  const expectedPayload = [
    { command: "help", description: "Show available commands" },
    { command: "abort", description: "Abort current operation" },
    { command: "new", description: "Start a new session" },
    { command: "compact", description: "Compact the current session" },
    {
      command: "reload",
      description: "Reload extensions, prompts, skills, and themes",
    },
    { command: "status", description: "Show current chat processing status" },
    { command: "session", description: "Show current session status" },
    { command: "model", description: "Show or change the current model" },
  ];

  assert.deepEqual(boot.buildTelegramCommandPayload(rows), expectedPayload);
  assert.deepEqual(
    boot.buildTelegramCommandPayload([
      { name: "HELP", description: "override" },
      { name: "help", description: "ignored duplicate" },
      { name: "bad name" },
      { name: "status" },
    ]),
    [
      { command: "help", description: "override" },
      { command: "status", description: "status" },
    ],
  );
  assert.deepEqual(boot.buildTelegramCommandClearScopes(), [
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ]);

  await boot.syncTelegramCommands(
    { bots: [bot], $commander: { updateCommands() {} } },
    { warn() {} },
    rows,
  );

  assert.deepEqual(deletes, [
    { scope: { type: "all_private_chats" } },
    { scope: { type: "all_group_chats" } },
    { scope: { type: "all_chat_administrators" } },
  ]);
  assert.deepEqual(sets, [
    {
      commands: expectedPayload,
    },
  ]);
});

test("chat boot claims outbox files before sending so concurrent drains do not duplicate delivery", async () => {
  await withTempDir(async (agentDir) => {
    const outboxDir = path.join(agentDir, "data", "chat-outbox");
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(
      path.join(outboxDir, "one.json"),
      JSON.stringify({
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "hello",
      }),
    );

    const sends = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage(chatId, content) {
            sends.push({ chatId, content });
            await new Promise((resolve) => setTimeout(resolve, 50));
            return ["m1"];
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    await Promise.all([
      boot.drainChatOutbox(app, agentDir, h, { warn() {} }),
      boot.drainChatOutbox(app, agentDir, h, { warn() {} }),
    ]);

    assert.equal(sends.length, 1);
  });
});

test("chat boot moves failed outbox deliveries into failed storage", async () => {
  await withTempDir(async (agentDir) => {
    const outboxDir = path.join(agentDir, "data", "chat-outbox");
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(
      path.join(outboxDir, "one.json"),
      JSON.stringify({
        type: "text_delivery",
        chatKey: "telegram/1:2",
        text: "hello",
      }),
    );

    const warnings = [];
    const app = {
      bots: [
        {
          platform: "telegram",
          selfId: "1",
          async sendMessage() {
            throw new Error("boom");
          },
        },
      ],
    };
    const h = {
      text(content) {
        return { type: "text", attrs: { content } };
      },
      quote(id) {
        return { type: "quote", attrs: { id } };
      },
    };

    await boot.drainChatOutbox(app, agentDir, h, {
      warn(message) {
        warnings.push(String(message));
      },
    });

    const failedDir = path.join(outboxDir, "failed");
    const failedFiles = await fs.readdir(failedDir);
    assert.deepEqual(failedFiles, ["one.json"]);
    assert.ok(
      warnings.some((message) => message.includes("chat outbox failed")),
    );
  });
});

test("chat boot moves invalid outbox json into failed storage instead of dropping it", async () => {
  await withTempDir(async (agentDir) => {
    const outboxDir = path.join(agentDir, "data", "chat-outbox");
    await fs.mkdir(outboxDir, { recursive: true });
    await fs.writeFile(path.join(outboxDir, "bad.json"), "{not json\n");

    const warnings = [];
    await boot.drainChatOutbox(
      { bots: [] },
      agentDir,
      {},
      {
        warn(message) {
          warnings.push(String(message));
        },
      },
    );

    const failedDir = path.join(outboxDir, "failed");
    const failedFiles = await fs.readdir(failedDir);
    assert.deepEqual(failedFiles, ["bad.json"]);
    assert.ok(
      warnings.some(
        (message) =>
          message.includes("chat outbox failed") &&
          message.includes("chat_outbox_invalid_json"),
      ),
    );
  });
});
