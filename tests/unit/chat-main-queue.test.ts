import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

test("chat main consumes inbound help messages through the inbox path only once", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { trusted: { trust: "TRUSTED" } },
        aliases: [{ platform: "telegram", userId: "trusted-1", personId: "trusted" }],
        trusted: ["trusted"],
      });

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "trusted-1",
        messageId: "m1",
        isDirect: true,
        content: "/help",
        stripped: { content: "/help" },
        elements: [h.createChatRuntimeH().text("/help")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const text = rows[0]?.text || "";
      const db = databaseMod.openChatDatabase(agentDir);
      const terminal = db.prepare(
        "SELECT outbox.idempotency_key, outbox.post_delivery_json, turns.state " +
        "FROM outbox JOIN turns ON turns.turn_id = outbox.turn_id " +
        "WHERE outbox.delivery_kind = 'command_ack'",
      ).all();
      if (
        rows.length !== 1 ||
        terminal.length !== 1 ||
        !terminal[0].idempotency_key ||
        JSON.parse(terminal[0].post_delivery_json).markProcessed.messageId !== "m1" ||
        terminal[0].state !== "terminal" ||
        !text.includes("/help — Show available commands") ||
        !text.includes("/usage — Show usage and quota status") ||
        text.includes("/model —") ||
        text.includes("/session —") ||
        text.includes("/status —")
      ) {
        throw new Error(JSON.stringify({
          sentCount,
          assistantCount: rows.length,
          texts: rows.map((item) => item.text),
        }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat send reports adapter dispatch as pending until delivery settles", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-main-dispatch-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const outboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js")).href);
      const bridge = await mainMod.startChatBridge({ hosted: true });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        sendMessage() {
          const delivery = new Promise((resolve) =>
            setTimeout(() => resolve(["provider-late"]), 100),
          );
          delivery.dispatched = Promise.resolve();
          return delivery;
        },
      });
      const result = await bridge.send({
        chatKey: "telegram/1:2",
        parts: [{ type: "text", text: "async delivery" }],
      });
      if (result.delivered !== false || result.pending !== true || !result.outboxId) {
        throw new Error(JSON.stringify(result));
      }
      const deadline = Date.now() + 3000;
      let item;
      while (Date.now() < deadline) {
        item = outboxMod.readChatOutboxItemById(agentDir, result.outboxId)?.item;
        if (item?.status === "delivered") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (item?.status !== "delivered") throw new Error(JSON.stringify(item));
      bridge.app.bots[0].sendMessage = () => {
        const error = Object.assign(new Error("chat_delivery_partial:upload"), {
          deliveredMessageIds: ["placeholder-1"],
          partialDelivery: true,
        });
        const delivery = Promise.reject(error);
        delivery.dispatched = Promise.resolve();
        return delivery;
      };
      const partialResult = await bridge.send({
        chatKey: "telegram/1:2",
        parts: [{ type: "text", text: "partial delivery" }],
      });
      if (
        partialResult.delivered !== false ||
        partialResult.pending !== true ||
        !partialResult.outboxId
      ) {
        throw new Error(JSON.stringify(partialResult));
      }
      const partialDeadline = Date.now() + 3000;
      let partialItem;
      while (Date.now() < partialDeadline) {
        partialItem = outboxMod.readChatOutboxItemById(
          agentDir,
          partialResult.outboxId,
        )?.item;
        if (partialItem?.status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (
        partialItem?.status !== "failed" ||
        partialItem.failureKind !== "partial" ||
        partialItem.deliveryUnconfirmed
      ) {
        throw new Error(JSON.stringify(partialItem));
      }
      bridge.app.bots[0].sendMessage = () => {
        const error = new Error("temporary network failure");
        const delivery = Promise.reject(error);
        delivery.dispatched = Promise.reject(error);
        return delivery;
      };
      const queuedResult = await bridge.send({
        chatKey: "telegram/1:2",
        parts: [{ type: "text", text: "durably queued" }],
      });
      const queuedItem = outboxMod.readChatOutboxItemById(
        agentDir,
        queuedResult.outboxId,
      )?.item;
      await bridge.stop();
      if (
        queuedResult.delivered !== false ||
        queuedResult.pending !== true ||
        queuedItem?.status !== "queued"
      ) {
        throw new Error(JSON.stringify({ queuedResult, queuedItem }));
      }
      process.exit(0);
    `;
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15_000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("telegram topic commands use the thread-scoped chat key", async () => {
  const tempRoot = os.tmpdir();
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-topic-command-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      controllerMod.ChatController.prototype.runCommand = async function (commandLine, replyToMessageId, incomingMessageId, sessionFile, promptMeta, outboxTurnFence) {
        seen.push({ commandLine, chatKey: this.chatKey, promptMeta, outboxTurnFence });
        return { handled: true, text: "ok" };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-100123",
        guildId: "-100123",
        userId: "owner-1",
        messageId: "m-topic-command",
        messageThreadId: "193",
        chatThreadId: "193",
        isTopicMessage: true,
        isDirect: false,
        content: "/usage",
        stripped: { content: "/usage" },
        elements: [h.createChatRuntimeH().text("/usage")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.messageId === "m-topic-command");
      console.log(JSON.stringify({ seen, rows }));
      process.exit(0);
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
    const records = stdout
      .trim()
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
    const result = JSON.parse(records.at(-1) || "{}");
    assert.equal(result.seen?.length, 1);
    assert.equal(result.seen[0].chatKey, "telegram/1:-100123?thread=193");
    assert.equal(
      result.seen[0].promptMeta?.chatKey,
      "telegram/1:-100123?thread=193",
    );
    assert.equal(
      result.seen[0].outboxTurnFence?.chatKey,
      "telegram/1:-100123?thread=193",
    );
    assert.equal(result.seen[0].outboxTurnFence?.messageId, "m-topic-command");
    assert.ok(result.seen[0].outboxTurnFence?.turnId);
    assert.equal(result.rows?.[0]?.chatKey, "telegram/1:-100123?thread=193");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main ignores private help commands from untrusted senders", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "stranger-1",
        messageId: "m-untrusted-help",
        isDirect: true,
        content: "/help",
        stripped: { content: "/help" },
        elements: [h.createChatRuntimeH().text("/help")],
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");

      if (sentCount !== 0 || rows.length !== 0) {
        throw new Error(JSON.stringify({ sentCount, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 10000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat startup does not restore inbox work before adapters are ready", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "delayed", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      inbox.enqueueChatInboxItem(agentDir, {
        chatKey: "delayed/1:2",
        messageId: "startup-not-ready",
        session: {
          platform: "delayed",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "startup-not-ready",
          timestamp: Date.now(),
          isDirect: true,
          content: "hello",
          stripped: { content: "hello" },
        },
        elements: [{ type: "text", attrs: { content: "hello" } }],
      });
      const pending = inbox.listPendingChatInboxItems(agentDir);
      if (
        pending.length !== 1 ||
        !inbox.claimChatInboxItem(agentDir, pending[0].itemId, {
          nowMs: 0,
          leaseMs: 1,
        })
      ) {
        throw new Error("processing_fixture_not_ready");
      }

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        return { handled: true };
      };
      let releaseAdapterStart;
      const adapterStartGate = new Promise((resolve) => {
        releaseAdapterStart = resolve;
      });
      const starting = mainMod.startChatBridge({
        hosted: true,
        chatAdapterProviders: [{
          key: "delayed",
          name: "Delayed",
          config: {},
          provider: () => ({
            adapter: {
              async start() {
                await adapterStartGate;
              },
              async stop() {},
            },
            bot: {
              platform: "delayed",
              selfId: "1",
              status: 1,
              async sendMessage() { return ["sent"]; },
            },
          }),
        }],
      });

      await new Promise((resolve) => setTimeout(resolve, 3500));
      const callsBeforeReady = runTurnCalls;
      releaseAdapterStart();
      const bridge = await starting;
      await bridge.stop();
      if (callsBeforeReady !== 0) {
        throw new Error(JSON.stringify({ callsBeforeReady }));
      }
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main periodically restores processing inbox items whose startup lease expires later", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    const byChatKey = {};
    for (let index = 0; index < 9; index += 1) {
      byChatKey[`telegram/1:${index}`] = { turnPolicy: "record_only" };
    }
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ chat: { byChatKey } }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);

      for (let index = 0; index < 9; index += 1) {
        inbox.enqueueChatInboxItem(agentDir, {
          chatKey: \`telegram/1:\${index}\`,
          messageId: \`startup-restore-\${index}\`,
          session: {
            platform: "telegram",
            selfId: "1",
            channelId: String(index),
            userId: "u1",
            messageId: \`startup-restore-\${index}\`,
            timestamp: Date.now(),
            isDirect: true,
            content: "hello",
            stripped: { content: "hello" },
          },
          elements: [{ type: "text", attrs: { content: "hello" } }],
        });
      }
      for (const item of inbox.listPendingChatInboxItems(agentDir)) {
        inbox.claimChatInboxItem(agentDir, item.itemId, {
          nowMs: Date.now(),
          leaseMs: 2500,
        });
      }
      if (inbox.listRunningChatInboxItems(agentDir).length !== 9) {
        throw new Error("processing_fixture_not_ready");
      }

      const bridge = await mainMod.startChatBridge();
      try {
        if (inbox.listRunningChatInboxItems(agentDir).length !== 9) {
          throw new Error("startup_recovered_unexpired_lease");
        }
        const deadline = Date.now() + 6000;
        let processingCount = Infinity;
        while (Date.now() < deadline) {
          processingCount = inbox.listRunningChatInboxItems(agentDir).length;
          if (processingCount === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (processingCount !== 0) {
          throw new Error(JSON.stringify({ processingCount }));
        }
      } finally {
        await bridge.stop();
      }
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main records record-only chat messages without starting an agent turn", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        chat: {
          byChatKey: {
            "telegram/1:2": { turnPolicy: "record_only" },
          },
        },
      }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          throw new Error("record-only message should not send a reply");
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-record-only",
        isDirect: true,
        content: "please just record this",
        stripped: { content: "please just record this" },
        elements: [h.createChatRuntimeH().text("please just record this")],
      });

      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "user");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));

      if (rows.length !== 1 || rows[0]?.text !== "please just record this" || seen.length !== 0) {
        throw new Error(JSON.stringify({ rows, seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main records record-only chat commands without running command handlers", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        chat: {
          byChatKey: {
            "telegram/1:2": { turnPolicy: "record_only" },
          },
        },
      }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { trusted: { trust: "TRUSTED" } },
        aliases: [{ platform: "telegram", userId: "trusted-1", personId: "trusted" }],
        trusted: ["trusted"],
      });

      controllerMod.ChatController.prototype.runCommand = async function (commandLine) {
        seen.push({ type: "command", commandLine });
        return { handled: true, text: "should not run" };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ type: "turn", mode, text: input?.text || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          throw new Error("record-only command should not send a reply");
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "trusted-1",
        messageId: "m-record-only-command",
        isDirect: true,
        content: "/new",
        stripped: { content: "/new" },
        elements: [h.createChatRuntimeH().text("/new")],
      });

      const deadline = Date.now() + 5000;
      let userRows = [];
      while (Date.now() < deadline) {
        userRows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "user");
        if (userRows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const assistantRows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");

      if (
        userRows.length !== 1 ||
        userRows[0]?.text !== "/new" ||
        seen.length !== 0 ||
        assistantRows.length !== 0
      ) {
        throw new Error(JSON.stringify({ userRows, assistantRows, seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main applies per-chat model options to inbound prompt turns", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        chat: {
          byChatKey: {
            "telegram/1:2": {
              model: "openai-codex/gpt-5.5",
              thinkingLevel: "low",
            },
          },
        },
      }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || null, model: input?.model, thinkingLevel: input?.thinkingLevel });
        return { finalText: "ok" };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["sent-1"];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-model-options",
        isDirect: true,
        content: "use configured model",
        stripped: { content: "use configured model" },
        elements: [h.createChatRuntimeH().text("use configured model")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (
        seen.length !== 1 ||
        seen[0].model !== "openai-codex/gpt-5.5" ||
        seen[0].thinkingLevel !== "low"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat runTurn lets explicit model options override per-chat defaults", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        chat: {
          byChatKey: {
            "telegram/1:2": {
              model: "openai-codex/default",
              thinkingLevel: "low",
            },
          },
        },
      }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const seen = [];

      controllerMod.ChatController.prototype.runTurn = async function (input) {
        seen.push({ text: input?.text || null, model: input?.model, thinkingLevel: input?.thinkingLevel });
        return { finalText: "ok" };
      };

      const bridge = await mainMod.startChatBridge();
      await bridge.runTurn({
        chatKey: "telegram/1:2",
        text: "explicit override",
        model: "openai-codex/override",
        thinkingLevel: "high",
      });
      await bridge.runTurn({
        chatKey: "telegram/1:2",
        text: "blank falls back",
        model: "  ",
        thinkingLevel: "",
      });

      if (
        seen.length !== 2 ||
        seen[0].model !== "openai-codex/override" ||
        seen[0].thinkingLevel !== "high" ||
        seen[1].model !== "openai-codex/default" ||
        seen[1].thinkingLevel !== "low"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main silently drops the removed private /session command", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
        return { handled: true, text: "should not run" };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-session-command",
        isDirect: true,
        content: "/session",
        stripped: { content: "/session" },
        elements: [h.createChatRuntimeH().text("/session")],
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");

      if (
        runCommandCalls !== 0 ||
        seen.length !== 0 ||
        sentCount !== 0 ||
        rows.length !== 0
      ) {
        throw new Error(JSON.stringify({ sentCount, runCommandCalls, seen, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main reports unmatched slash commands in owner-only Lark groups", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "lark", userId: "ou_owner", personId: "owner" }],
        trusted: [],
      });

      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
        return { handled: true, text: "should not run" };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "lark",
        selfId: "cli_bot",
        internal: {
          async listChatMembers() {
            return {
              code: 0,
              data: {
                items: [{ member_id: "ou_owner" }],
                has_more: false,
                member_total: 1,
              },
            };
          },
          async getChat() {
            return { code: 0, data: { user_count: "1", bot_count: "1" } };
          },
        },
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });
      const node = h.createChatRuntimeH();
      app.emit("message", {
        platform: "lark",
        selfId: "cli_bot",
        channelId: "oc_owner_only",
        guildId: "oc_owner_only",
        userId: "ou_owner",
        messageId: "om-owner-only-unknown",
        isDirect: false,
        content: "/unknown",
        stripped: { content: "/unknown" },
        elements: [node.text("/unknown")],
      });

      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "lark/cli_bot:oc_owner_only" && item.role === "assistant");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (
        runCommandCalls !== 0 ||
        seen.length !== 0 ||
        sentCount !== 1 ||
        rows.length !== 1 ||
        rows[0]?.text !== "rin error: Unknown command. Send /help to see available commands."
      ) {
        throw new Error(JSON.stringify({ sentCount, runCommandCalls, seen, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main silently consumes unmatched group slash commands", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
        return { handled: true, text: "should not run" };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        username: "rin_bot",
        name: "rin_bot",
        async sendMessage() {
          throw new Error("unmatched group command should not send a reply");
        },
      });
      const node = h.createChatRuntimeH();
      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-10042",
        guildId: "-10042",
        userId: "owner-1",
        messageId: "m-group-unknown",
        isDirect: false,
        content: "/unknown @rin_bot",
        stripped: { appel: true, content: "/unknown" },
        elements: [node.text("/unknown "), node.at("1", { name: "rin_bot" })],
      });

      await new Promise((resolve) => setTimeout(resolve, 1200));
      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:-10042" && item.role === "assistant");

      if (runCommandCalls !== 0 || seen.length !== 0 || rows.length !== 0) {
        throw new Error(JSON.stringify({ runCommandCalls, seen, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main lets trusted group commands run without owner-present checks or command whitelists", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { trusted: { trust: "TRUSTED" } },
        aliases: [{ platform: "telegram", userId: "trusted-1", personId: "trusted" }],
        trusted: ["trusted"],
      });

      controllerMod.ChatController.prototype.runCommand = async function (
        commandLine,
        replyToMessageId,
        incomingMessageId,
        sessionFile,
        promptMeta,
      ) {
        seen.push({ commandLine, replyToMessageId, incomingMessageId, sessionFile, promptMeta });
        return { handled: true, text: "ok" };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        username: "rin_bot",
        name: "rin_bot",
        async sendMessage() {
          return ["sent"];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-10042",
        guildId: "-10042",
        userId: "trusted-1",
        username: "TrustedNick",
        messageId: "m-trusted-usage",
        isDirect: false,
        content: "/usage",
        stripped: { content: "/usage" },
        elements: [h.createChatRuntimeH().text("/usage")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const call = seen[0];
      if (
        seen.length !== 1 ||
        call.commandLine !== "/usage" ||
        call.replyToMessageId !== "m-trusted-usage" ||
        call.incomingMessageId !== "m-trusted-usage" ||
        call.sessionFile !== "" ||
        call.promptMeta?.chatKey !== "telegram/1:-10042" ||
        call.promptMeta?.chatType !== "group" ||
        call.promptMeta?.userId !== "trusted-1" ||
        call.promptMeta?.identity !== "TRUSTED"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main forwards command sender identity without reply session binding", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const fs = await import("node:fs/promises");
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { trusted: { trust: "TRUSTED" } },
        aliases: [{ platform: "telegram", userId: "trusted-1", personId: "trusted" }],
        trusted: ["trusted"],
      });

      controllerMod.ChatController.prototype.runCommand = async function (
        commandLine,
        replyToMessageId,
        incomingMessageId,
        sessionFile,
        promptMeta,
      ) {
        seen.push({ commandLine, replyToMessageId, incomingMessageId, sessionFile, promptMeta });
        return { handled: true, text: "ok" };
      };

      const repliedSessionFile = path.join(agentDir, "sessions", "replied-old-session.jsonl");
      await fs.mkdir(path.dirname(repliedSessionFile), { recursive: true });
      await fs.writeFile(repliedSessionFile, "", "utf8");
      storeMod.saveChatMessage(agentDir, {
        messageId: "assistant-old",
        role: "assistant",
        chatKey: "telegram/1:2",
        platform: "telegram",
        botId: "1",
        chatId: "2",
        chatType: "private",
        receivedAt: new Date(1767225599000).toISOString(),
        text: "old assistant reply",
        sessionFile: repliedSessionFile,
      });

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["sent"];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "trusted-1",
        username: "TrustedNick",
        messageId: "m-new",
        timestamp: 1767225600000,
        isDirect: true,
        content: "/new",
        stripped: { content: "/new" },
        elements: [
          h.createChatRuntimeH().quote("assistant-old"),
          h.createChatRuntimeH()("br"),
          h.createChatRuntimeH().text("/new"),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const call = seen[0];
      if (
        seen.length !== 1 ||
        call.commandLine !== "/new" ||
        call.replyToMessageId !== "m-new" ||
        call.incomingMessageId !== "m-new" ||
        call.sessionFile !== "" ||
        call.promptMeta?.replyToMessageId !== undefined ||
        call.promptMeta?.source !== "chat-bridge" ||
        "triggerKind" in (call.promptMeta || {}) ||
        call.promptMeta?.chatKey !== "telegram/1:2" ||
        call.promptMeta?.chatType !== "private" ||
        call.promptMeta?.userId !== "trusted-1" ||
        call.promptMeta?.nickname !== "TrustedNick" ||
        call.promptMeta?.identity !== "TRUSTED"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main ignores removed /auth private commands from untrusted senders without mutating chat identity", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "u1",
        username: "owner-user",
        messageId: "m1",
        isDirect: true,
        content: "/auth owner",
        stripped: { content: "/auth owner" },
        elements: [h.createChatRuntimeH().text("/auth owner")],
      });

      await new Promise((resolve) => setTimeout(resolve, 750));

      const identity = supportMod.loadIdentity(path.join(agentDir, "data"));
      if (supportMod.trustOf(identity, "telegram", "u1") !== "OTHER") {
        throw new Error(JSON.stringify(identity));
      }
      if (sentCount !== 0) {
        throw new Error(JSON.stringify({ sentCount }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 10000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main does not retry a queued prompt while the controller is already handling that inbound message", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let promptCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/slow-chat.jsonl",
            getSessionId: () => "slow-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            return {
              sessionFile: "/tmp/slow-chat.jsonl",
              sessionId: "slow-session",
            };
          },
          prompt: async (_message, options = {}) => {
            promptCalls += 1;
            setTimeout(() => {
              controller.handleClientEvent({
                type: "ui",
                payload: {
                  type: "rpc_turn_event",
                  event: "complete",
                  requestTag: options.requestTag,
                  finalText: "slow reply",
                  result: { messages: [{ type: "text", text: "slow reply" }] },
                  sessionId: "slow-session",
                  sessionFile: "/tmp/slow-chat.jsonl",
                },
              });
            }, 10);
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-slow",
        isDirect: true,
        content: "hello slow world",
        stripped: { content: "hello slow world" },
        elements: [h.createChatRuntimeH().text("hello slow world")],
      });

      await new Promise((resolve) => setTimeout(resolve, 12500));

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      if (promptCalls !== 1 || rows.length !== 1) {
        throw new Error(JSON.stringify({
          promptCalls,
          assistantCount: rows.length,
          texts: rows.map((item) => item.text),
        }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 25000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main routes active-turn /new through the chatKey worker immediately", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const promptTags = [];
      const newSessionCalls = [];
      let releasePromptStart;
      const promptStartGate = new Promise((resolve) => {
        releasePromptStart = resolve;
      });
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/active-new-chat.jsonl",
            getSessionId: () => "active-new-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/active-new-chat.jsonl",
            sessionId: "active-new-session",
          }),
          prompt: async (_message, options = {}) => {
            promptTags.push(options.requestTag || "");
            controller.session.isStreaming = true;
            await promptStartGate;
            await controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "start",
                requestTag: options.requestTag,
              },
            });
          },
          newSession: async (options = {}) => {
            newSessionCalls.push({
              chatKey: controller.chatKey,
              managedSessionLeaf: options.managedSessionLeaf || "",
            });
            controller.session.isStreaming = false;
            await controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "error",
                requestTag: promptTags[0],
                error: "chat_turn_aborted",
                sessionId: "active-new-session",
                sessionFile: "/tmp/active-new-chat.jsonl",
              },
            });
            return true;
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      const makeMessage = (messageId, content) => ({
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId,
        isDirect: true,
        content,
        stripped: { content },
        elements: [h.createChatRuntimeH().text(content)],
      });

      app.emit("message", makeMessage("m-active", "start long turn"));
      const promptDeadline = Date.now() + 5000;
      while (Date.now() < promptDeadline && promptTags.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const baselineNewSessionCalls = newSessionCalls.length;
      app.emit("message", makeMessage("m-new", "/new"));

      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (
          newSessionCalls.length > baselineNewSessionCalls &&
          rows.some((item) => item.text === "Started a new session.")
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releasePromptStart();
      if (
        promptTags.length !== 1 ||
        newSessionCalls.length <= baselineNewSessionCalls ||
        newSessionCalls.at(-1)?.chatKey !== "telegram/1:2" ||
        newSessionCalls.at(-1)?.managedSessionLeaf !== "chat" ||
        !rows.some((item) => item.text === "Started a new session.")
      ) {
        throw new Error(JSON.stringify({ promptTags, newSessionCalls, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main submits /abort without waiting for a same-chat prompt to finish", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const promptTags = [];
      let abortCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/abort-same-queue-chat.jsonl",
            getSessionId: () => "abort-same-queue-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/abort-same-queue-chat.jsonl",
            sessionId: "abort-same-queue-session",
          }),
          agent: {
            abort: () => {
              abortCalls += 1;
              controller.session.isStreaming = false;
            },
          },
          prompt: async (_message, options = {}) => {
            promptTags.push(options.requestTag || "");
            controller.session.isStreaming = true;
            await new Promise(() => {});
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      const makeMessage = (messageId, content, userId = "owner-1") => ({
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId,
        messageId,
        isDirect: true,
        content,
        stripped: { content },
        elements: [h.createChatRuntimeH().text(content)],
      });

      app.emit("message", makeMessage("m-active", "start long turn"));
      const promptDeadline = Date.now() + 5000;
      while (Date.now() < promptDeadline && promptTags.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (promptTags.length !== 1) {
        throw new Error(JSON.stringify({ stage: "prompt-not-started", promptTags }));
      }

      app.emit(
        "message",
        makeMessage("m-untrusted-chatter", "not for Rin", "stranger-1"),
      );
      app.emit("message", makeMessage("m-abort", "/abort"));
      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (abortCalls > 0 && rows.some((item) => item.text === "Aborted current operation.")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        abortCalls !== 1 ||
        !rows.some((item) => item.text === "Aborted current operation.")
      ) {
        throw new Error(JSON.stringify({ abortCalls, promptTags, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main submits same-chat follow-up plainly before backend steer admission", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const promptModes = [];
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/steer-chat.jsonl",
            getSessionId: () => "steer-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/steer-chat.jsonl",
            sessionId: "steer-session",
          }),
          prompt: async (_message, options = {}) => {
            promptModes.push(options.streamingBehavior || "prompt");
            if (controller.session.isStreaming) return { acceptedAs: "steer" };
            controller.session.isStreaming = true;
            await new Promise(() => {});
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      const makeMessage = (messageId, content) => ({
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId,
        isDirect: true,
        content,
        stripped: { content },
        elements: [h.createChatRuntimeH().text(content)],
      });

      app.emit("message", makeMessage("m-one", "first"));
      const firstDeadline = Date.now() + 5000;
      while (Date.now() < firstDeadline && promptModes.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      app.emit("message", makeMessage("m-two", "second"));

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && promptModes.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const pendingItems = inbox.listChatInboxItems(agentDir, ["pending"]);
      const processingItems = inbox.listChatInboxItems(agentDir, ["running"]);
      const failedItems = inbox.listChatInboxItems(agentDir, ["failed"]);
      if (promptModes.length !== 2 || promptModes[0] !== "prompt" || promptModes[1] !== "prompt" || pendingItems.length || failedItems.length || processingItems.length < 1) {
        throw new Error(JSON.stringify({ promptModes, pendingItems, processingItems, failedItems }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main finalizes once after controller returns from canonical terminal settlement", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const chatHelpersMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js")).href);
      const outbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const listInbox = (name) =>
        inbox.listChatInboxItems(agentDir, [name === "processing" ? "running" : name]);

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function (input) {
        runTurnCalls += 1;
        outbox.enqueueChatOutboxPayload(agentDir, {
          createdAt: new Date().toISOString(),
          chatKey: this.chatKey,
          parts: [{ type: "text", text: "ordinary final" }],
        }, {
          deliveryKind: "final",
          postDelivery: {
            markProcessed: {
              chatKey: this.chatKey,
              messageId: input.incomingMessageId,
            },
          },
        });
        chatHelpersMod.markProcessedChatMessage(agentDir, this.chatKey, input.incomingMessageId, {
          acceptedAt: new Date().toISOString(),
          processedAt: new Date().toISOString(),
          sessionFile: "/tmp/ordinary-final.jsonl",
        });
        return { finalText: "ordinary final", sessionFile: "/tmp/ordinary-final.jsonl" };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-delivered",
        isDirect: true,
        content: "ordinary input",
        stripped: { content: "ordinary input" },
        elements: [h.createChatRuntimeH().text("ordinary input")],
      });

      const deadline = Date.now() + 18000;
      while (Date.now() < deadline) {
        if (
          runTurnCalls === 1 &&
          listInbox("pending").length === 0 &&
          listInbox("processing").length === 0 &&
          listInbox("failed").length === 0
        ) {
          process.exit(0);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(JSON.stringify({
        runTurnCalls,
        pending: listInbox("pending"),
        processing: listInbox("processing"),
        failed: listInbox("failed"),
      }));
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 22000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main reports daemon startup failure without retrying", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let connectCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        connectCalls += 1;
        if (connectCalls === 1) {
          throw new Error("connect ENOENT /run/user/1001/rin-daemon/daemon.sock");
        }
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/retry-chat.jsonl",
            getSessionId: () => "retry-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/retry-chat.jsonl",
            sessionId: "retry-session",
          }),
          prompt: async (_message, options = {}) => {
            controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "complete",
                requestTag: options.requestTag,
                finalText: "retry reply",
                result: { messages: [{ type: "text", text: "retry reply" }] },
                sessionId: "retry-session",
                sessionFile: "/tmp/retry-chat.jsonl",
              },
            });
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return ["assistant-" + sentCount];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-retry",
        isDirect: true,
        content: "hello retry",
        stripped: { content: "hello retry" },
        elements: [h.createChatRuntimeH().text("hello retry")],
      });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.some((item) => item.text === "retry reply")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const errorNotice = rows.find((item) => String(item.text || "").includes("connect ENOENT"));
      const succeeded = rows.some((item) => item.text === "retry reply");
      if (succeeded || !errorNotice || errorNotice.deliveryKind !== "error" || connectCalls !== 1) {
        throw new Error(JSON.stringify({ connectCalls, errorNotice, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main resumes a durably admitted turn after policy changes", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-durable-admission-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let phase = "first";
      let runTurnCalls = 0;
      const submittedTurns = [];
      let releaseFirstTurn;
      const firstTurnGate = new Promise((resolve) => { releaseFirstTurn = resolve; });
      controllerMod.ChatController.prototype.runTurn = async function (input) {
        runTurnCalls += 1;
        submittedTurns.push(JSON.parse(JSON.stringify(input)));
        if (phase === "first") {
          await firstTurnGate;
          throw new Error("Request was aborted");
        }
        return { finalText: "resumed original execution" };
      };
      controllerMod.ChatController.prototype.detachForDaemonShutdown = async function () {};

      const createBot = () => ({
        platform: "telegram",
        selfId: "1",
        async sendMessage() { return ["assistant-1"]; },
        internal: { async sendChatAction() {} },
      });
      const first = await mainMod.startChatBridge({ hosted: true });
      first.app.bots.push(createBot());
      first.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-policy-change",
        isDirect: true,
        content: "finish this after update",
        stripped: { content: "finish this after update" },
        elements: [h.createChatRuntimeH().text("finish this after update")],
      });

      const admittedDeadline = Date.now() + 5000;
      while (Date.now() < admittedDeadline && runTurnCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (runTurnCalls !== 1) throw new Error("first turn was not admitted");
      await first.stop();
      databaseMod.closeChatDatabase(agentDir);

      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ chat: { byChatKey: { "telegram/1:2": { turnPolicy: "record_only" } } } }) + "\\n",
        "utf8",
      );
      phase = "recovery";
      const second = await mainMod.startChatBridge({ hosted: true });
      second.app.bots.push(createBot());
      const terminalDeadline = Date.now() + 5000;
      let row;
      while (Date.now() < terminalDeadline) {
        row = databaseMod.openChatDatabase(agentDir).prepare(
          "SELECT turns.state, turns.admission_state, messages.disposition " +
          "FROM turns JOIN messages ON messages.id = turns.inbound_message_id " +
          "WHERE messages.message_id = 'm-policy-change'",
        ).get();
        if (row?.state === "terminal") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releaseFirstTurn();
      await new Promise((resolve) => setImmediate(resolve));
      await second.stop();
      if (
        runTurnCalls !== 2 ||
        JSON.stringify(submittedTurns[0]) !== JSON.stringify(submittedTurns[1]) ||
        row?.state !== "terminal" ||
        row?.admission_state !== "actionable" ||
        row?.disposition !== "actionable"
      ) {
        throw new Error(JSON.stringify({ runTurnCalls, submittedTurns, row }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main resumes a frozen command after sender identity changes", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-durable-command-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      let phase = "first";
      const calls = [];
      let releaseFirstCommand;
      const firstCommandGate = new Promise((resolve) => { releaseFirstCommand = resolve; });
      controllerMod.ChatController.prototype.runCommand = async function (
        commandLine,
        replyToMessageId,
        incomingMessageId,
        sessionFile,
        promptMeta,
      ) {
        calls.push({ commandLine, replyToMessageId, incomingMessageId, sessionFile, promptMeta });
        if (phase === "first") {
          await firstCommandGate;
          throw new Error("Request was aborted");
        }
      };
      controllerMod.ChatController.prototype.detachForDaemonShutdown = async function () {
        releaseFirstCommand();
      };
      const createBot = () => ({
        platform: "telegram",
        selfId: "1",
        async sendMessage() { return ["assistant-1"]; },
        internal: { async sendChatAction() {} },
      });
      const first = await mainMod.startChatBridge({ hosted: true });
      first.app.bots.push(createBot());
      first.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-frozen-command",
        isDirect: true,
        content: "/new",
        stripped: { content: "/new" },
        elements: [h.createChatRuntimeH().text("/new")],
      });
      const admittedDeadline = Date.now() + 5000;
      while (Date.now() < admittedDeadline && calls.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (calls.length !== 1) throw new Error("first command was not admitted");
      await first.stop();
      databaseMod.closeChatDatabase(agentDir);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: {},
        aliases: [],
        trusted: [],
      });
      phase = "recovery";
      const second = await mainMod.startChatBridge({ hosted: true });
      second.app.bots.push(createBot());
      const db = databaseMod.openChatDatabase(agentDir);
      const terminalDeadline = Date.now() + 5000;
      let row;
      while (Date.now() < terminalDeadline) {
        row = db.prepare(
          "SELECT state, admission_state FROM turns WHERE inbound_message_id = " +
          "(SELECT id FROM messages WHERE message_id = 'm-frozen-command')",
        ).get();
        if (row?.state === "terminal") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await second.stop();
      if (
        calls.length !== 2 ||
        calls[0].promptMeta?.identity !== "OWNER" ||
        JSON.stringify(calls[0]) !== JSON.stringify(calls[1]) ||
        row?.state !== "terminal" ||
        row?.admission_state !== "actionable"
      ) {
        throw new Error(JSON.stringify({ calls, row }));
      }
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main recovers unmatched commands from frozen response metadata", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-durable-unmatched-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);

      const item = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "telegram/1:2",
        messageId: "m-frozen-unmatched",
        session: {
          platform: "telegram",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "m-frozen-unmatched",
          timestamp: Date.now(),
          isDirect: true,
          content: "/future-command",
          stripped: { content: "/future-command" },
        },
        elements: [{ type: "text", attrs: { content: "/future-command" } }],
      }).item;
      const claim = inboxMod.claimChatInboxItem(agentDir, item.itemId);
      const admission = inboxMod.commitClaimedChatInboxAdmission(agentDir, claim, {
        state: "actionable",
        decision: {
          version: 1,
          kind: "unmatched_command",
          chatKey: item.chatKey,
          messageId: item.messageId,
          name: "future-command",
          trust: "OWNER",
          respond: true,
        },
      });
      if (admission?.decisionIntegrity !== "valid") {
        throw new Error("unmatched command admission was not durable");
      }
      inboxMod.requeueClaimedChatInboxItem(agentDir, claim, { delayMs: 0 });
      const db = databaseMod.openChatDatabase(agentDir);
      const mutatedSession = {
        platform: "telegram",
        selfId: "1",
        channelId: "group:changed",
        guildId: "changed",
        userId: "stranger",
        messageId: "mutated-message",
        isDirect: false,
        content: "mutated content",
        stripped: { content: "mutated content" },
      };
      db.prepare("UPDATE turns SET session_json = ? WHERE turn_id = ?").run(
        JSON.stringify(mutatedSession),
        item.itemId,
      );

      let runTurnCalls = 0;
      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
      };
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
      };
      const started = await mainMod.startChatBridge({ hosted: true });
      let sentCount = 0;
      started.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() { sentCount += 1; return ["sent-unmatched"]; },
        internal: { async sendChatAction() {} },
      });
      const deadline = Date.now() + 5000;
      let turn;
      let outboxCount = 0;
      while (Date.now() < deadline) {
        turn = db.prepare("SELECT state, terminal_kind FROM turns WHERE turn_id = ?")
          .get(item.itemId);
        outboxCount = db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE turn_id = ?")
          .get(item.itemId).count;
        if (turn?.state === "terminal" && outboxCount === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await started.stop();
      if (
        runTurnCalls !== 0 ||
        runCommandCalls !== 0 ||
        turn?.state !== "terminal" ||
        outboxCount !== 1 ||
        sentCount > 1
      ) {
        throw new Error(JSON.stringify({
          runTurnCalls,
          runCommandCalls,
          turn,
          outboxCount,
          sentCount,
        }));
      }
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main fails closed for unverifiable actionable admissions", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-legacy-admission-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = `
      import crypto from "node:crypto";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "legacy", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      const item = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "legacy/1:2",
        messageId: "legacy-accepted-without-submission",
        session: {
          platform: "legacy",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "legacy-accepted-without-submission",
          timestamp: Date.now(),
          isDirect: true,
          content: "do not submit this again",
          stripped: { content: "do not submit this again" },
        },
        elements: [{ type: "text", attrs: { content: "do not submit this again" } }],
      }).item;
      const hashless = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "legacy/1:2",
        messageId: "actionable-without-submission-hash",
        session: {
          platform: "legacy",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "actionable-without-submission-hash",
          timestamp: Date.now(),
          isDirect: true,
          content: "do not trust an unhashed submission",
          stripped: { content: "do not trust an unhashed submission" },
        },
        elements: [{ type: "text", attrs: { content: "do not trust an unhashed submission" } }],
      }).item;
      const dirtyUnclassified = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "legacy/1:2",
        messageId: "unclassified-with-admission-residue",
        session: {
          platform: "legacy",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "unclassified-with-admission-residue",
          timestamp: Date.now(),
          isDirect: true,
          content: "do not classify this corrupted turn",
          stripped: { content: "do not classify this corrupted turn" },
        },
        elements: [{ type: "text", attrs: { content: "do not classify this corrupted turn" } }],
      }).item;
      const dirtyCommand = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "legacy/1:2",
        messageId: "command-with-submission-residue",
        session: {
          platform: "legacy",
          selfId: "1",
          channelId: "2",
          userId: "owner-1",
          messageId: "command-with-submission-residue",
          timestamp: Date.now(),
          isDirect: true,
          content: "/new",
          stripped: { content: "/new" },
        },
        elements: [{ type: "text", attrs: { content: "/new" } }],
      }).item;
      const db = databaseMod.openChatDatabase(agentDir);
      db.prepare(
        "UPDATE turns SET admission_state = 'actionable', admission_json = ?, " +
        "submission_json = NULL, submission_hash = NULL WHERE turn_id = ?",
      ).run(JSON.stringify({ version: 1, kind: "obsolete_projection" }), item.itemId);
      const hashlessSubmission = JSON.stringify({
        version: 1,
        chatKey: hashless.chatKey,
        incomingMessageId: hashless.messageId,
        text: "do not trust an unhashed submission",
        attachments: [],
        promptMeta: { chatKey: hashless.chatKey, identity: "OWNER" },
      });
      const hashlessDecision = JSON.stringify({
        version: 1,
        kind: "message",
        decision: { allow: true },
      });
      const admissionHash = crypto
        .createHash("sha256")
        .update(hashlessDecision)
        .digest("hex");
      db.prepare(
        "UPDATE turns SET admission_state = 'actionable', admission_json = ?, " +
        "admission_hash = ?, submission_json = ?, submission_hash = NULL " +
        "WHERE turn_id = ?",
      ).run(
        hashlessDecision,
        admissionHash,
        hashlessSubmission,
        hashless.itemId,
      );
      db.prepare(
        "UPDATE turns SET admission_json = ?, admission_hash = ? WHERE turn_id = ?",
      ).run("{}", "mismatch", dirtyUnclassified.itemId);
      const dirtyCommandDecision = JSON.stringify({
        version: 1,
        kind: "command",
        chatKey: dirtyCommand.chatKey,
        messageId: dirtyCommand.messageId,
        command: { name: "new", argsText: "" },
        trust: "OWNER",
        promptMeta: { chatKey: dirtyCommand.chatKey, identity: "OWNER" },
      });
      db.prepare(
        "UPDATE turns SET admission_state = 'actionable', admission_json = ?, " +
        "admission_hash = ?, submission_json = '{}', submission_hash = 'mismatch' " +
        "WHERE turn_id = ?",
      ).run(
        dirtyCommandDecision,
        crypto.createHash("sha256").update(dirtyCommandDecision).digest("hex"),
        dirtyCommand.itemId,
      );
      db.prepare(
        "UPDATE messages SET accepted_at = ?, disposition = 'actionable' " +
        "WHERE message_id IN (?, ?, ?, ?)",
      ).run(
        new Date().toISOString(),
        item.messageId,
        hashless.messageId,
        dirtyUnclassified.messageId,
        dirtyCommand.messageId,
      );

      let runTurnCalls = 0;
      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        return { finalText: "duplicate execution" };
      };
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
        return { handled: true, text: "duplicate command" };
      };
      const bridgeOptions = {
        hosted: true,
        chatAdapterProviders: [{
          key: "legacy",
          name: "Legacy",
          config: {},
          provider: () => ({
            adapter: { async start() {}, async stop() {} },
            bot: {
              platform: "legacy",
              selfId: "1",
              status: 1,
              async sendMessage() { return ["unknown-notice"]; },
            },
          }),
        }],
      };
      const bridge = await mainMod.startChatBridge(bridgeOptions);
      try {
        const deadline = Date.now() + 5000;
        let rows = [];
        while (Date.now() < deadline) {
          rows = db.prepare(
            "SELECT turns.turn_id, turns.state, turns.terminal_kind " +
            "FROM turns WHERE turns.turn_id IN (?, ?, ?, ?)",
          ).all(
            item.itemId,
            hashless.itemId,
            dirtyUnclassified.itemId,
            dirtyCommand.itemId,
          );
          if (
            rows.length === 4 &&
            rows.every((row) => row.state === "terminal")
          ) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const terminals = db.prepare(
          "SELECT delivery_kind, payload_json FROM outbox WHERE turn_id IN (?, ?, ?, ?)",
        ).all(
          item.itemId,
          hashless.itemId,
          dirtyUnclassified.itemId,
          dirtyCommand.itemId,
        );
        const texts = terminals.map((terminal) =>
          JSON.parse(terminal.payload_json).parts
            .map((part) => part.text || "")
            .join("\\n"),
        );
        if (
          runTurnCalls !== 0 ||
          runCommandCalls !== 0 ||
          rows.length !== 4 ||
          rows.some(
            (row) =>
              row.state !== "terminal" ||
              row.terminal_kind !== "interrupted_unknown",
          ) ||
          terminals.length !== 4 ||
          terminals.some((terminal) => terminal.delivery_kind !== "error") ||
          texts.some((text) => !text.includes("was not submitted again"))
        ) {
          throw new Error(JSON.stringify({ runTurnCalls, runCommandCalls, rows, terminals, texts }));
        }
      } finally {
        await bridge.stop();
      }
      const outboxCountBeforeRestart = db.prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE turn_id IN (?, ?, ?, ?)",
      ).get(
        item.itemId,
        hashless.itemId,
        dirtyUnclassified.itemId,
        dirtyCommand.itemId,
      ).count;
      const restarted = await mainMod.startChatBridge(bridgeOptions);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await restarted.stop();
      const outboxCountAfterRestart = db.prepare(
        "SELECT COUNT(*) AS count FROM outbox WHERE turn_id IN (?, ?, ?, ?)",
      ).get(
        item.itemId,
        hashless.itemId,
        dirtyUnclassified.itemId,
        dirtyCommand.itemId,
      ).count;
      if (
        runTurnCalls !== 0 ||
        runCommandCalls !== 0 ||
        outboxCountBeforeRestart !== 4 ||
        outboxCountAfterRestart !== 4
      ) {
        throw new Error(JSON.stringify({
          runTurnCalls,
          runCommandCalls,
          outboxCountBeforeRestart,
          outboxCountAfterRestart,
        }));
      }
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("hosted chat bridge shutdown detaches active frontends without aborting sessions", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let detachCalls = 0;
      let shutdownCalls = 0;
      let disposeCalls = 0;
      let releaseDetach;
      const detachGate = new Promise((resolve) => { releaseDetach = resolve; });
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        await new Promise(() => {});
      };
      controllerMod.ChatController.prototype.detachForDaemonShutdown = async function () {
        detachCalls += 1;
        await detachGate;
      };
      controllerMod.ChatController.prototype.shutdownSession = async function () {
        shutdownCalls += 1;
        throw new Error("hosted daemon shutdown must not terminate sessions");
      };
      controllerMod.ChatController.prototype.dispose = function () {
        disposeCalls += 1;
      };

      const bridge = await mainMod.startChatBridge({ hosted: true });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-hosted-shutdown",
        isDirect: true,
        content: "hello shutdown",
        stripped: { content: "hello shutdown" },
        elements: [h.createChatRuntimeH().text("hello shutdown")],
      });
      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "3",
        userId: "owner-1",
        messageId: "m-hosted-shutdown-second-chat",
        isDirect: true,
        content: "hello second chat",
        stripped: { content: "hello second chat" },
        elements: [h.createChatRuntimeH().text("hello second chat")],
      });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && runTurnCalls < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const stopping = bridge.stop();
      const releaseDeadline = Date.now() + 3000;
      let processingFiles = [];
      while (Date.now() < releaseDeadline) {
        processingFiles = inbox.listChatInboxItems(agentDir, ["pending", "running"]);
        if (
          processingFiles.length === 2 &&
          processingFiles.every((item) => item.state === "pending")
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      releaseDetach();
      await stopping;
      const failedFiles = inbox.listChatInboxItems(agentDir, ["failed"]);
      const assistantRows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const allReleased = processingFiles.every(
        (item) => item.state === "pending" && !item.ownerEpoch && !item.leaseUntil,
      );
      if (runTurnCalls !== 2 || detachCalls !== 2 || shutdownCalls !== 0 || disposeCalls !== 0 || processingFiles.length !== 2 || !allReleased || failedFiles.length !== 0 || assistantRows.length !== 0) {
        throw new Error(JSON.stringify({ runTurnCalls, detachCalls, shutdownCalls, disposeCalls, processingFiles, failedFiles, assistantRows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main requeues frontend lifecycle aborts without delivering an error", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import fs from "node:fs";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const inbox = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        throw new Error("Request was aborted");
      };

      const bridge = await mainMod.startChatBridge({ hosted: true });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: { async sendChatAction() {} },
      });

      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-lifecycle-abort",
        isDirect: true,
        content: "update now",
        stripped: { content: "update now" },
        elements: [h.createChatRuntimeH().text("update now")],
      });

      const deadline = Date.now() + 8000;
      let pendingFiles = [];
      while (Date.now() < deadline) {
        pendingFiles = inbox.listChatInboxItems(agentDir, ["pending"]);
        if (runTurnCalls >= 1 && pendingFiles.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await bridge.stop();
      const failedFiles = inbox.listChatInboxItems(agentDir, ["failed"]);
      const assistantRows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      if (runTurnCalls !== 1 || pendingFiles.length !== 1 || failedFiles.length !== 0 || assistantRows.length !== 0) {
        throw new Error(JSON.stringify({ runTurnCalls, pendingFiles, failedFiles, assistantRows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main commits one terminal error so restart recovery cannot replay the same inbound", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const chatHelpersMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-helpers.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function (input) {
        runTurnCalls += 1;
        chatHelpersMod.markProcessedChatMessage(
          agentDir,
          this.chatKey,
          input.incomingMessageId,
          { acceptedAt: new Date().toISOString() },
        );
        throw undefined;
      };
      const createBot = () => ({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-" + Date.now() + "-" + Math.random()];
        },
        internal: { async sendChatAction() {} },
      });

      const first = await mainMod.startChatBridge({ hosted: true });
      first.app.bots.push(createBot());
      first.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-terminal-error-once",
        isDirect: true,
        content: "continue interrupted turn",
        stripped: { content: "continue interrupted turn" },
        elements: [h.createChatRuntimeH().text("continue interrupted turn")],
      });

      const firstDeadline = Date.now() + 8000;
      while (Date.now() < firstDeadline) {
        const errors = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant" && item.deliveryKind === "error");
        if (errors.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await first.stop();

      const second = await mainMod.startChatBridge({ hosted: true });
      second.app.bots.push(createBot());
      const secondDeadline = Date.now() + 3000;
      while (Date.now() < secondDeadline && runTurnCalls < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await second.stop();

      const inbound = storeMod.getChatMessage(
        agentDir,
        "telegram/1:2",
        "m-terminal-error-once",
      );
      const errors = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant" && item.deliveryKind === "error");
      if (runTurnCalls !== 1 || !inbound?.processedAt || errors.length !== 1) {
        throw new Error(JSON.stringify({ runTurnCalls, inbound, errors }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat startup honors terminal outbox ownership before orphan inbox recovery", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const outboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey: "telegram/1:2",
        platform: "telegram",
        botId: "1",
        chatId: "2",
        chatType: "private",
        messageId: "m-crash-window",
        role: "user",
        receivedAt: new Date().toISOString(),
        acceptedAt: new Date().toISOString(),
        userId: "owner-1",
        text: "accepted before crash",
      });
      outboxMod.enqueueChatOutboxPayload(
        agentDir,
        {
          createdAt: new Date().toISOString(),
          chatKey: "telegram/1:2",
          deliveryKind: "error",
          parts: [
            { type: "quote", id: "m-crash-window" },
            { type: "text", text: "one terminal error" },
          ],
        },
        {
          id: "error-crash-window",
          idempotencyKey: "error-crash-window",
          deliveryKind: "error",
          postDelivery: {
            markProcessed: {
              chatKey: "telegram/1:2",
              messageId: "m-crash-window",
              bindSession: false,
            },
          },
        },
      );

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        throw new Error("inbound_replayed_after_terminal_commit");
      };

      const bridge = await mainMod.startChatBridge({ hosted: true });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-crash-window"];
        },
        internal: { async sendChatAction() {} },
      });

      const deadline = Date.now() + 5000;
      let inbound;
      let errors = [];
      while (Date.now() < deadline) {
        inbound = storeMod.getChatMessage(
          agentDir,
          "telegram/1:2",
          "m-crash-window",
        );
        errors = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant" && item.deliveryKind === "error");
        if (inbound?.processedAt && errors.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await bridge.stop();

      if (runTurnCalls !== 0 || !inbound?.processedAt || errors.length !== 1) {
        throw new Error(JSON.stringify({ runTurnCalls, inbound, errors }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main reports an offline-queued frontend turn without retrying", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const originalRunTurn = controllerMod.ChatController.prototype.runTurn;
      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/offline-queued-chat.jsonl",
            getSessionId: () => "offline-queued-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/offline-queued-chat.jsonl",
            sessionId: "offline-queued-session",
          }),
          prompt: async (_message, options = {}) => {
            controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "complete",
                requestTag: options.requestTag,
                finalText: "retry after queued offline",
                result: { messages: [{ type: "text", text: "retry after queued offline" }] },
                sessionId: "offline-queued-session",
                sessionFile: "/tmp/offline-queued-chat.jsonl",
              },
            });
          },
          switchSession: async () => {},
        };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        runTurnCalls += 1;
        if (runTurnCalls === 1) {
          throw new Error("rin_disconnected:rpc_turn_queued_offline");
        }
        return await originalRunTurn.call(this, input, mode);
      };

      const { app } = await mainMod.startChatBridge();
      let sentCount = 0;
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          sentCount += 1;
          return ["assistant-" + sentCount];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-offline-queued",
        isDirect: true,
        content: "hello offline queued",
        stripped: { content: "hello offline queued" },
        elements: [h.createChatRuntimeH().text("hello offline queued")],
      });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.some((item) => item.text === "retry after queued offline")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const errorNotice = rows.find((item) => String(item.text || "").includes("queued_offline"));
      const succeeded = rows.some((item) => item.text === "retry after queued offline");
      if (succeeded || !errorNotice || runTurnCalls !== 1) {
        throw new Error(JSON.stringify({ runTurnCalls, errorNotice, rows }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main passes quoted reply rich text through one normal prompt submission", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const chatKey = "telegram/1:2";
      const replySessionFile = path.join(agentDir, "sessions", "linked", "reply-history.jsonl");
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "2",
        chatType: "private",
        messageId: "m-linked",
        role: "assistant",
        receivedAt: new Date().toISOString(),
        text: "old reply",
        sessionFile: replySessionFile,
      });

      controllerMod.ChatController.prototype.resumeSessionFile = async function () {
        throw new Error("main_should_not_pre_resume_reply_session");
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({
          mode,
          text: input?.text || "",
          promptMetaReplyTo: input?.promptMeta?.replyToMessageId || null,
          sessionFile: input?.sessionFile || null,
          replyToMessageId: input?.replyToMessageId || null,
          receivedAt: input?.receivedAt || null,
        });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-follow",
        isDirect: true,
        content: "continue here",
        stripped: { content: "continue here" },
        elements: [
          {
            type: "quote",
            attrs: { id: "m-linked" },
            children: [],
          },
          { type: "br", attrs: {}, children: [] },
          h.createChatRuntimeH().text("continue here"),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      const first = seen[0];
      if (
        first.mode !== undefined ||
        first.text !== "[quote:m-linked]\\ncontinue here" ||
        first.promptMetaReplyTo !== null ||
        first.sessionFile !== replySessionFile ||
        first.replyToMessageId !== "m-follow" ||
        !Number.isFinite(Date.parse(first.receivedAt || ""))
      ) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main omits quote rich text when quoting the latest assistant message", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const chatKey = "telegram/1:2";
      const replySessionFile = path.join(agentDir, "sessions", "linked", "latest.jsonl");
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "2",
        chatType: "private",
        messageId: "m-latest-assistant",
        role: "assistant",
        receivedAt: new Date().toISOString(),
        deliveryKind: "final",
        text: "latest assistant reply",
        sessionFile: replySessionFile,
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({
          mode,
          text: input?.text || "",
          promptMetaReplyTo: input?.promptMeta?.replyToMessageId || null,
          sessionFile: input?.sessionFile || null,
          replyToMessageId: input?.replyToMessageId || null,
        });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-follow",
        isDirect: true,
        content: "continue here",
        stripped: { content: "continue here" },
        elements: [
          {
            type: "quote",
            attrs: { id: "m-latest-assistant" },
            children: [],
          },
          { type: "br", attrs: {}, children: [] },
          h.createChatRuntimeH().text("continue here"),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) throw new Error(JSON.stringify({ seen }));
      const first = seen[0];
      if (
        first.mode !== undefined ||
        first.text !== "continue here" ||
        first.sessionFile !== replySessionFile ||
        first.replyToMessageId !== "m-follow" ||
        first.promptMetaReplyTo !== null
      ) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main inlines own unsessioned quoted content into the prompt", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const chatKey = "telegram/1:-10042";
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "-10042",
        chatType: "group",
        messageId: "m-rich-source",
        role: "user",
        userId: "owner-1",
        receivedAt: new Date().toISOString(),
        text: "look at this image",
        elements: [
          { type: "text", attrs: { content: "look at this image" } },
          { type: "image", attrs: { src: "https://example.com/cat.png", name: "cat.png" } },
        ],
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({
          mode,
          text: input?.text || "",
          promptMetaReplyTo: input?.promptMeta?.replyToMessageId || null,
          sessionFile: input?.sessionFile || null,
          replyToMessageId: input?.replyToMessageId || null,
        });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        username: "rin_bot",
        name: "rin_bot",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });
      const node = h.createChatRuntimeH();
      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-10042",
        guildId: "-10042",
        userId: "owner-1",
        messageId: "m-mention-quote",
        isDirect: false,
        content: "@rin_bot please explain this",
        stripped: { appel: true, content: "please explain this" },
        elements: [
          {
            type: "quote",
            attrs: { id: "m-rich-source" },
            children: [],
          },
          { type: "br", attrs: {}, children: [] },
          node.at("1", { name: "rin_bot" }),
          node.text("please explain this"),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) throw new Error(JSON.stringify({ seen }));
      const first = seen[0];
      if (
        first.mode !== undefined ||
        first.sessionFile !== null ||
        first.replyToMessageId !== "m-mention-quote" ||
        first.promptMetaReplyTo !== null ||
        first.text !== "look at this image\\n\\nplease explain this"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main keeps another sender's unsessioned quoted content lazy", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const chatKey = "telegram/1:-10042";
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "-10042",
        chatType: "group",
        messageId: "m-rich-source",
        role: "user",
        userId: "other-1",
        receivedAt: new Date().toISOString(),
        text: "quoted body should only be fetched explicitly",
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({
          mode,
          text: input?.text || "",
          promptMetaReplyTo: input?.promptMeta?.replyToMessageId || null,
          sessionFile: input?.sessionFile || null,
          replyToMessageId: input?.replyToMessageId || null,
        });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        username: "rin_bot",
        name: "rin_bot",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });
      const node = h.createChatRuntimeH();
      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-10042",
        guildId: "-10042",
        userId: "owner-1",
        messageId: "m-mention-quote",
        isDirect: false,
        content: "@rin_bot",
        stripped: { appel: true, content: "" },
        elements: [
          {
            type: "quote",
            attrs: { id: "m-rich-source" },
            children: [],
          },
          { type: "br", attrs: {}, children: [] },
          node.at("1", { name: "rin_bot" }),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) throw new Error(JSON.stringify({ seen }));
      const first = seen[0];
      if (
        first.mode !== undefined ||
        first.sessionFile !== null ||
        first.replyToMessageId !== "m-mention-quote" ||
        first.promptMetaReplyTo !== null ||
        first.text !== "[quote:m-rich-source]"
      ) {
        throw new Error(JSON.stringify({ seen }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main does not downgrade a quoted reply to a plain turn when linked session selection times out", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const { installChatControllerSessionClient } = await import(pathToFileURL(path.join(rootDir, "tests", "support", "chat-controller-session-client.ts")).href);
      installChatControllerSessionClient(controllerMod.ChatController);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const chatKey = "telegram/1:2";
      const replySessionFile = path.join(agentDir, "sessions", "linked", "reply-history.jsonl");
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      storeMod.saveChatMessage(agentDir, {
        chatKey,
        platform: "telegram",
        botId: "1",
        chatId: "2",
        chatType: "private",
        messageId: "m-linked",
        role: "assistant",
        receivedAt: new Date().toISOString(),
        text: "old reply",
        sessionFile: replySessionFile,
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({
          mode,
          sessionFile: input?.sessionFile || null,
          replyToMessageId: input?.replyToMessageId || null,
        });
        throw new Error("rin_timeout:select_session");
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-1"];
        },
        internal: {
          async sendChatAction() {},
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-follow",
        isDirect: true,
        content: "continue here",
        stripped: { content: "continue here" },
        elements: [
          {
            type: "quote",
            attrs: { id: "m-linked" },
            children: [],
          },
          { type: "br", attrs: {}, children: [] },
          h.createChatRuntimeH().text("continue here"),
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (seen.length !== 1) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      const [first] = seen;
      if (
        first.mode !== undefined ||
        first.sessionFile !== replySessionFile ||
        first.replyToMessageId !== "m-follow"
      ) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      process.exit(0);
    `;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
        timeout: 15000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
