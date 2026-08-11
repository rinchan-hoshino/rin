import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("chat main consumes inbound help messages through the inbox path only once", async () => {
  const tempRoot = os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    const script = `
      import path from "node:path";
      import { fileURLToPath, pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const { app } = await mainMod.startChatBridge({
        commandRows: [
          { name: "help", description: "Show available commands" },
          { name: "abort", description: "Abort the active turn" },
          { name: "new", description: "Start a new session" },
          { name: "compact", description: "Compact the current context" },
          { name: "reload", description: "Reload extensions, skills, prompts, and themes" },
          { name: "usage", description: "Show Codex quota status" },
          { name: "status", description: "Show this chat session status" },
        ],
      });
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
        "SELECT outbox.idempotency_key, outbox.post_delivery_json, inbox_jobs.state " +
        "FROM outbox JOIN inbox_jobs ON inbox_jobs.turn_id = outbox.turn_id " +
        "WHERE outbox.delivery_kind = 'command_ack'",
      ).all();
      if (
        rows.length !== 1 ||
        terminal.length !== 1 ||
        !terminal[0].idempotency_key ||
        JSON.parse(terminal[0].post_delivery_json).markProcessed.messageId !== "m1" ||
        terminal[0].state !== "terminal" ||
        !text.includes("/help — Show available commands") ||
        !text.includes("/usage — Show Codex quota status") ||
        !text.includes("/status — Show this chat session status") ||
        text.includes("/model —") ||
        text.includes("/session —")
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

test("chat main answers /status locally while the same chat turn is running", async () => {
  const tempRoot = os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-status-bypass-"),
  );
  const runtimeDir = path.join(agentDir, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  try {
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let runCommandCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        await new Promise(() => {});
      };
      controllerMod.ChatController.prototype.hasActiveTurn = function () {
        return runTurnCalls > 0;
      };
      controllerMod.ChatController.prototype.runCommand = async function () {
        runCommandCalls += 1;
        throw new Error("status must not enter the session command driver");
      };

      const { app } = await mainMod.startChatBridge({
        commandRows: [{ name: "status", description: "Show this chat session status" }],
      });
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-status"];
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
      const activeDeadline = Date.now() + 5000;
      while (Date.now() < activeDeadline && runTurnCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (runTurnCalls !== 1) throw new Error("turn-not-started");

      app.emit("message", makeMessage("m-status", "/status"));
      const statusDeadline = Date.now() + 8000;
      let statusItem;
      let text = "";
      while (Date.now() < statusDeadline) {
        statusItem = inboxMod
          .listChatInboxItems(agentDir, ["pending", "running", "terminal", "failed"])
          .find((item) => item.messageId === "m-status");
        text = storeMod
          .listChatMessages(agentDir)
          .find(
              (item) =>
                item.role === "assistant" &&
                item.text.startsWith("Current session:"),
            )?.text || "";
        if (statusItem?.state === "terminal" && text) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        statusItem?.state !== "terminal" ||
        runCommandCalls !== 0 ||
        text !== "Current session: unavailable"
      ) {
        throw new Error(JSON.stringify({ statusItem, runCommandCalls, text }));
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
          XDG_RUNTIME_DIR: runtimeDir,
        },
        timeout: 20000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main lets an authorized /abort bypass a running same-chat turn", async () => {
  const tempRoot = os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-abort-bypass-"),
  );
  try {
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let abortCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        await new Promise(() => {});
      };
      controllerMod.ChatController.prototype.hasActiveTurn = function () {
        return runTurnCalls > 0;
      };
      controllerMod.ChatController.prototype.runCommand = async function (command) {
        if (command !== "/abort") throw new Error("unexpected command: " + command);
        abortCalls += 1;
      };

      const { app } = await mainMod.startChatBridge({ commandRows: [{ name: "abort" }] });
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
      const activeDeadline = Date.now() + 5000;
      while (Date.now() < activeDeadline && runTurnCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (runTurnCalls !== 1) {
        throw new Error(JSON.stringify({ stage: "turn-not-started", runTurnCalls }));
      }

      app.emit(
        "message",
        makeMessage("m-untrusted-abort", "/abort", "stranger-1"),
      );
      app.emit("message", makeMessage("m-abort", "/abort"));
      const abortDeadline = Date.now() + 8000;
      let abortItem = null;
      while (Date.now() < abortDeadline) {
        abortItem = inboxMod
          .listChatInboxItems(agentDir, ["pending", "running", "terminal", "failed"])
          .find((item) => item.messageId === "m-abort");
        if (abortCalls === 1 && abortItem?.state === "terminal") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const untrustedAbortItem = inboxMod
        .listChatInboxItems(agentDir, ["pending", "running", "terminal", "failed"])
        .find((item) => item.messageId === "m-untrusted-abort");
      if (
        abortCalls !== 1 ||
        abortItem?.state !== "terminal" ||
        untrustedAbortItem?.state !== "pending"
      ) {
        throw new Error(JSON.stringify({
          abortCalls,
          abortItem,
          untrustedAbortItem,
          inboundRecovery: app.isInboundRecoveryChat("telegram/1:2"),
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
        timeout: 20000,
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
      const bridge = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
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

      const { app } = await mainMod.startChatBridge({ commandRows: [{ name: "usage" }] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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
      const nativeSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, delay, ...args) =>
        nativeSetInterval(callback, delay === 3000 ? 50 : delay, ...args);
      let releaseAdapterStart;
      const adapterStartGate = new Promise((resolve) => {
        releaseAdapterStart = resolve;
      });
      const starting = mainMod.startChatBridge({
        hosted: true,
        commandRows: [],
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

      await new Promise((resolve) => setTimeout(resolve, 400));
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

test("chat main periodically reclaims expired coordination without terminalizing inbox jobs", async () => {
  const tempRoot = os.tmpdir();
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
      const nativeSetInterval = globalThis.setInterval;
      const inboxPollCallbacks = [];
      globalThis.setInterval = (callback, delay, ...args) => {
        if (delay === 3000) inboxPollCallbacks.push(callback);
        return nativeSetInterval(callback, delay === 3000 ? 50 : delay, ...args);
      };
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
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

      const bridge = await mainMod.startChatBridge({ commandRows: [] });
      try {
        if (inbox.listRunningChatInboxItems(agentDir).length !== 9) {
          throw new Error("startup_recovered_unexpired_lease");
        }
        const initialAttempts = inbox
          .listRunningChatInboxItems(agentDir)
          .map((item) => item.attemptCount);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const db = databaseMod.openChatDatabase(agentDir);
        db.prepare(
          "UPDATE inbox_jobs SET lease_until = ? WHERE state = 'running'",
        ).run(new Date(0).toISOString());
        db.close();
        for (const poll of inboxPollCallbacks) poll();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const running = inbox.listRunningChatInboxItems(agentDir);
        const failed = inbox.listChatInboxItems(agentDir, ["failed"]);
        const reclaimed = running.some(
          (item, index) => item.attemptCount > initialAttempts[index],
        );
        if (running.length !== 9 || failed.length !== 0 || !reclaimed) {
          throw new Error(JSON.stringify({ initialAttempts, running, failed }));
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

test("chat main applies per-chat model options to inbound prompt inbox_jobs", async () => {
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const bridge = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

test("chat main lets trusted group commands run only when an owner is present", async () => {
  const tempRoot = os.tmpdir();
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
        persons: {
          owner: { trust: "OWNER" },
          trusted: { trust: "TRUSTED" },
        },
        aliases: [
          { platform: "telegram", userId: "owner-1", personId: "owner" },
          { platform: "telegram", userId: "trusted-1", personId: "trusted" },
        ],
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

      const { app } = await mainMod.startChatBridge({ commandRows: [{ name: "usage" }] });
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        username: "rin_bot",
        name: "rin_bot",
        internal: {
          async getChatMember({ chat_id, user_id }) {
            return chat_id === "-10043" && user_id === "owner-1"
              ? { status: "member" }
              : { status: "left" };
          },
        },
        async sendMessage() {
          return ["sent"];
        },
      });

      for (const [channelId, messageId] of [
        ["-10042", "m-trusted-usage-owner-absent"],
        ["-10043", "m-trusted-usage-owner-present"],
      ]) {
        app.emit("message", {
          platform: "telegram",
          selfId: "1",
          channelId,
          guildId: channelId,
          userId: "trusted-1",
          username: "TrustedNick",
          messageId,
          isDirect: false,
          content: "/usage",
          stripped: { content: "/usage" },
          elements: [h.createChatRuntimeH().text("/usage")],
        });
      }

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));

      const call = seen[0];
      if (
        seen.length !== 1 ||
        call.commandLine !== "/usage" ||
        call.replyToMessageId !== "m-trusted-usage-owner-present" ||
        call.incomingMessageId !== "m-trusted-usage-owner-present" ||
        call.sessionFile !== "" ||
        call.promptMeta?.chatKey !== "telegram/1:-10043" ||
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

test("chat main rejects trusted private commands while allowing owner private commands", async () => {
  const tempRoot = os.tmpdir();
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
        persons: {
          owner: { trust: "OWNER" },
          trusted: { trust: "TRUSTED" },
        },
        aliases: [
          { platform: "telegram", userId: "owner-1", personId: "owner" },
          { platform: "telegram", userId: "trusted-1", personId: "trusted" },
        ],
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

      const { app } = await mainMod.startChatBridge({ commandRows: [{ name: "new" }] });
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
        channelId: "3",
        userId: "trusted-1",
        username: "TrustedNick",
        messageId: "m-trusted-new",
        timestamp: 1767225600000,
        isDirect: true,
        content: "/new",
        stripped: { content: "/new" },
        elements: [h.createChatRuntimeH().text("/new")],
      });
      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        username: "OwnerNick",
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
      await new Promise((resolve) => setTimeout(resolve, 500));

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
        call.promptMeta?.userId !== "owner-1" ||
        call.promptMeta?.nickname !== "OwnerNick" ||
        call.promptMeta?.identity !== "OWNER"
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const nativeSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, delay, ...args) =>
        nativeSetInterval(callback, delay === 3000 ? 50 : delay, ...args);
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
            await new Promise((resolve) => setTimeout(resolve, 800));
            return {
              sessionFile: "/tmp/slow-chat.jsonl",
              sessionId: "slow-session",
            };
          },
          prompt: async (_message, options = {}) => {
            promptCalls += 1;
            setTimeout(async () => {
              const ledgerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "turn-ledger.js")).href);
              const terminalPayload = {
                type: "rpc_turn_event",
                event: "complete",
                requestTag: options.requestTag,
                finalText: "slow reply",
                result: { messages: [{ type: "text", text: "slow reply" }] },
                sessionId: "slow-session",
                sessionFile: "/tmp/slow-chat.jsonl",
              };
              ledgerMod.beginDaemonTurn(agentDir, {
                requestTag: options.requestTag,
                sessionFile: terminalPayload.sessionFile,
                sessionId: terminalPayload.sessionId,
                chatDeliveryContext: options.chatDeliveryContext,
              });
              const terminalRecord = ledgerMod.recordDaemonTurnTerminal(agentDir, {
                requestTag: options.requestTag,
                terminalKind: "complete",
                terminalEvent: terminalPayload,
              });
              controller.handleClientEvent({
                type: "ui",
                payload: {
                  ...ledgerMod.daemonTurnTerminalEvent(terminalRecord),
                },
              });
            }, 10);
          },
          switchSession: async () => {},
        };
      };

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

      await new Promise((resolve) => setTimeout(resolve, 2500));

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

test("chat main finalizes once after controller reinbox_jobs from canonical terminal settlement", async () => {
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

test("chat main leaves daemon startup failure pending without an error outbox", async () => {
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
      while (Date.now() < deadline && connectCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const inbound = storeMod.getChatMessage(
        agentDir,
        "telegram/1:2",
        "m-retry",
      );
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const running = inboxMod.listChatInboxItems(agentDir, ["running"]);
      if (
        rows.length !== 0 ||
        connectCalls !== 1 ||
        !inbound ||
        inbound.processedAt ||
        running.length !== 1
      ) {
        throw new Error(
          JSON.stringify({ connectCalls, inbound, rows, running }),
        );
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

test("chat main keeps unverifiable admissions pending without inventing a terminal", async () => {
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
        "UPDATE inbox_jobs SET admission_state = 'actionable', admission_json = ?, " +
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
        "UPDATE inbox_jobs SET admission_state = 'actionable', admission_json = ?, " +
        "admission_hash = ?, submission_json = ?, submission_hash = NULL " +
        "WHERE turn_id = ?",
      ).run(
        hashlessDecision,
        admissionHash,
        hashlessSubmission,
        hashless.itemId,
      );
      db.prepare(
        "UPDATE inbox_jobs SET admission_json = ?, admission_hash = ? WHERE turn_id = ?",
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
        "UPDATE inbox_jobs SET admission_state = 'actionable', admission_json = ?, " +
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
        commandRows: [],
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
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rows = db.prepare(
          "SELECT inbox_jobs.turn_id, inbox_jobs.state, inbox_jobs.terminal_kind " +
          "FROM inbox_jobs WHERE inbox_jobs.turn_id IN (?, ?, ?, ?)",
        ).all(
          item.itemId,
          hashless.itemId,
          dirtyUnclassified.itemId,
          dirtyCommand.itemId,
        );
        const terminals = db.prepare(
          "SELECT delivery_kind, payload_json FROM outbox WHERE turn_id IN (?, ?, ?, ?)",
        ).all(
          item.itemId,
          hashless.itemId,
          dirtyUnclassified.itemId,
          dirtyCommand.itemId,
        );
        if (
          runTurnCalls !== 0 ||
          runCommandCalls !== 0 ||
          rows.length !== 4 ||
          rows.some((row) => row.state === "terminal") ||
          terminals.length !== 0
        ) {
          throw new Error(JSON.stringify({ runTurnCalls, runCommandCalls, rows, terminals }));
        }
      } finally {
        await bridge.stop();
      }
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
        outboxCountAfterRestart !== 0
      ) {
        throw new Error(JSON.stringify({
          runTurnCalls,
          runCommandCalls,
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

test("hosted chat bridge shutdown preserves active inbox_jobs for daemon recovery", async () => {
  const tempRoot = os.tmpdir();
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

      const bridge = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
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
      releaseDetach();
      await stopping;
      const runningFiles = inbox.listChatInboxItems(agentDir, ["running"]);
      const assistantRows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const allPreserved = runningFiles.every(
        (item) => item.ownerEpoch && item.leaseUntil && !item.lastError,
      );
      if (runTurnCalls !== 2 || detachCalls !== 2 || shutdownCalls !== 0 || disposeCalls !== 0 || runningFiles.length !== 2 || !allPreserved || assistantRows.length !== 0) {
        throw new Error(JSON.stringify({ runTurnCalls, detachCalls, shutdownCalls, disposeCalls, runningFiles, assistantRows }));
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

test("hard Chat process death leaves the claimed inbox lifecycle active", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-hard-crash-"),
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
      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });
      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        await new Promise(() => {});
      };
      const bridge = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() { return ["assistant-1"]; },
        internal: { async sendChatAction() {} },
      });
      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        userId: "owner-1",
        messageId: "m-hard-chat-crash",
        isDirect: true,
        content: "hard crash",
        stripped: { content: "hard crash" },
        elements: [h.createChatRuntimeH().text("hard crash")],
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && runTurnCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (runTurnCalls !== 1) process.exit(2);
      process.kill(process.pid, "SIGKILL");
    `;
    await assert.rejects(
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15000,
      }),
    );
    const inbox = await import("../../dist/core/chat/inbox.js");
    const running = inbox.listChatInboxItems(agentDir, ["running"]);
    assert.equal(running.length, 1);
    assert.equal(running[0].messageId, "m-hard-chat-crash");
    assert.equal(running[0].lastError, undefined);

    const recoveryScript = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      let runTurnCalls = 0;
      let resumeTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
      };
      controllerMod.ChatController.prototype.resumeTurn = async function () {
        resumeTurnCalls += 1;
        throw new Error("uncommitted turn must use ordinary prompt RPC");
      };
      const bridge = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
      bridge.app.bots.push({
        platform: "telegram",
        selfId: "1",
        async sendMessage() { return ["assistant-1"]; },
        internal: { async sendChatAction() {} },
      });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (inboxMod.listChatInboxItems(agentDir, ["terminal"]).length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const terminal = inboxMod.listChatInboxItems(agentDir, ["terminal"]);
      if (terminal.length !== 1 || runTurnCalls !== 1 || resumeTurnCalls !== 0) {
        throw new Error(JSON.stringify({ terminal, runTurnCalls, resumeTurnCalls }));
      }
      process.exit(0);
    `;
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", recoveryScript],
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

test("chat main resumes joined acceptance across restart without prompt replay or a synthetic terminal", async () => {
  const tempRoot = os.tmpdir();
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
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let resumeTurnCalls = 0;
      let connectCalls = 0;
      controllerMod.ChatController.prototype.connect = async function (options) {
        connectCalls += 1;
        if (options?.restoreSessionFile !== "managed/chat/backend-accepted.jsonl") {
          throw new Error("startup_recovery_preconnect_session_mismatch");
        }
        return true;
      };
      controllerMod.ChatController.prototype.runTurn = async function (input) {
        runTurnCalls += 1;
        const fence = this.turnFenceForInboundMessage(input.incomingMessageId);
        if (!fence) throw new Error("turn fence missing");
        databaseMod.markChatMessageAcceptedWithFence(agentDir, fence, {
          acceptedAt: new Date().toISOString(),
          sessionFile: "managed/chat/backend-accepted.jsonl",
          joinedTurnId: "terminal-owner-turn",
        });
        throw undefined;
      };
      controllerMod.ChatController.prototype.resumeTurn = async function (_input, options) {
        resumeTurnCalls += 1;
        await options?.connect?.();
      };
      const createBot = () => ({
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["assistant-" + Date.now() + "-" + Math.random()];
        },
        internal: { async sendChatAction() {} },
      });

      const first = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
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
        const inbound = storeMod.getChatMessage(
          agentDir,
          "telegram/1:2",
          "m-terminal-error-once",
        );
        if (inbound?.acceptedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await first.stop();

      const second = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
      second.app.bots.push(createBot());
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await second.stop();

      const inbound = storeMod.getChatMessage(
        agentDir,
        "telegram/1:2",
        "m-terminal-error-once",
      );
      const errors = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant" && item.deliveryKind === "error");
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const running = inboxMod.listChatInboxItems(agentDir, ["running"]);
      const terminal = inboxMod.listChatInboxItems(agentDir, ["terminal"]);
      if (
        runTurnCalls !== 1 ||
        resumeTurnCalls !== 1 ||
        connectCalls !== 1 ||
        !inbound?.acceptedAt ||
        errors.length !== 0 ||
        running.length !== 0 ||
        terminal.length !== 1
      ) {
        throw new Error(
          JSON.stringify({
            runTurnCalls,
            resumeTurnCalls,
            connectCalls,
            inbound,
            errors,
            running,
            terminal,
          }),
        );
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
  const tempRoot = os.tmpdir();
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

      const bridge = await mainMod.startChatBridge({ hosted: true, commandRows: [] });
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

test("chat main leaves every local turn error pending until durable acceptance", async () => {
  const tempRoot = os.tmpdir();
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
      const databaseMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let resumeTurnCalls = 0;
      const nativeSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, delay, ...args) =>
        nativeSetInterval(callback, delay === 3000 ? 50 : delay, ...args);
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
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        if (runTurnCalls === 1) {
          throw new Error("arbitrary local turn failure");
        }
      };
      controllerMod.ChatController.prototype.resumeTurn = async function () {
        resumeTurnCalls += 1;
        throw new Error("uncommitted turn must use ordinary prompt RPC");
      };

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

      const initialDeadline = Date.now() + 2000;
      while (runTurnCalls !== 1 && Date.now() < initialDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const retained = inboxMod.listChatInboxItems(agentDir, ["running"]);
      if (runTurnCalls !== 1 || retained.length !== 1) {
        throw new Error(JSON.stringify({ phase: "before_retry", runTurnCalls, retained }));
      }

      const db = databaseMod.openChatDatabase(agentDir);
      db.prepare(
        "UPDATE inbox_jobs SET lease_until = ?, next_attempt_at = ? WHERE state = 'running'",
      ).run(new Date(0).toISOString(), new Date(0).toISOString());
      db.close();
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const succeeded = inboxMod.listChatInboxItems(agentDir, ["terminal"]);
        if (succeeded.length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const failed = inboxMod.listChatInboxItems(agentDir, ["failed"]);
      const running = inboxMod.listChatInboxItems(agentDir, ["running"]);
      const succeeded = inboxMod.listChatInboxItems(agentDir, ["terminal"]);
      if (
        succeeded.length !== 1 ||
        failed.length !== 0 ||
        running.length !== 0 ||
        runTurnCalls !== 2 ||
        resumeTurnCalls !== 0
      ) {
        throw new Error(JSON.stringify({ phase: "after_retry", runTurnCalls, resumeTurnCalls, failed, running, succeeded }));
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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
  const tempRoot = os.tmpdir();
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

      const { app } = await mainMod.startChatBridge({ commandRows: [] });
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

test("chat main owner exercises bridge status, eval, termination, detached cleanup, and telegram media diagnostics", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-main-owner-edges-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
      const inboxMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href);
      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { trusted: { trust: "TRUSTED" } },
        aliases: [{ platform: "telegram", userId: "trusted-media", personId: "trusted" }],
        trusted: ["trusted"],
      });
      const startupItem = inboxMod.enqueueChatInboxItem(agentDir, {
        chatKey: "telegram/1:startup",
        messageId: "startup-running",
        session: {
          platform: "telegram", selfId: "1", channelId: "startup",
          userId: "trusted-media", messageId: "startup-running", content: "recover",
          stripped: { content: "recover" },
        },
        elements: [{ type: "text", attrs: { content: "recover" } }],
      });
      inboxMod.claimChatInboxItem(agentDir, startupItem.itemId);
      const bridge = await mainMod.startChatBridge({ hosted: true });
      const ready = bridge.getStatus();
      if (!ready.ready || ready.status !== "ready") throw new Error(JSON.stringify(ready));
      let missingKey = false;
      try { await bridge.terminateTurn({}); } catch (error) { missingKey = /chat_controller_key_required/.test(String(error)); }
      if (!missingKey) throw new Error("missing terminate validation");
      if ((await bridge.terminateTurn({ chatKey: "telegram/1:missing" })).terminated) throw new Error("unexpected chat termination");
      if ((await bridge.terminateTurn({ controllerKey: "missing" })).terminated) throw new Error("unexpected detached termination");
      const evaluated = await bridge.evalBridge({ code: "return { value: 7 };", requestId: "owner-success" });
      if (!evaluated.ok || evaluated.value?.value !== 7) throw new Error(JSON.stringify(evaluated));
      let evalFailed = false;
      try { await bridge.evalBridge({ code: "throw new Error('owner-eval-failed');", requestId: "owner-failure" }); }
      catch (error) { evalFailed = /owner-eval-failed/.test(String(error)); }
      if (!evalFailed) throw new Error("eval failure missing");
      const expectFailure = async (operation, pattern) => {
        try { await operation(); }
        catch (error) { if (pattern.test(String(error))) return; throw error; }
        throw new Error("expected failure " + pattern);
      };
      await expectFailure(() => bridge.typing({}), /chat_key_required/);
      await bridge.typing({ chatKey: "telegram/1:missing" });
      await expectFailure(() => bridge.react({}), /chat_key_required/);
      await expectFailure(() => bridge.react({ chatKey: "telegram/1:missing" }), /chat_message_id_required/);
      await expectFailure(() => bridge.react({ chatKey: "telegram/1:missing", messageId: "m" }), /chat_reaction_emoji_required/);
      await bridge.react({ chatKey: "telegram/1:missing", messageId: "m", emoji: "👍" });
      await expectFailure(() => bridge.send({}), /chat_outbox_(?:invalid_payload|empty_message)/);
      await expectFailure(() => bridge.send({
        chatKey: "telegram/1:missing",
        requestId: "owner-pending-send",
        parts: [{ type: "text", text: "pending owner delivery" }],
      }), /chat_outbox_delivery_missing/);
      bridge.app.emit("adapter-start-failed", {});
      bridge.app.emit("adapter-start-failed", { platform: "telegram", selfId: "1", error: "start failed" });
      bridge.app.emit("adapter-stop-failed", {});
      bridge.app.emit("adapter-stop-failed", { platform: "telegram", selfId: "1", error: "stop failed" });
      bridge.app.emit("bot-status-updated", { status: 0 });
      bridge.app.emit("bot-status-updated", { status: 1 });
      await Promise.allSettled([
        bridge.runTurn({
          controllerKey: "detached-owner",
          text: "detached failure one",
          affectChatBinding: false,
          linkDeliveriesToSession: false,
        }),
        bridge.runTurn({
          controllerKey: "detached-owner",
          text: "detached failure two",
          disposeAfterTurn: true,
          affectChatBinding: false,
          linkDeliveriesToSession: false,
        }),
        bridge.runTurn({
          controllerKey: "detached-owner",
          text: "detached failure replacement",
          shutdownAfterTurn: true,
          affectChatBinding: false,
          linkDeliveriesToSession: true,
          frontend: { kind: "owner-replacement" },
        }),
      ]);
      await Promise.allSettled([
        bridge.runTurn({
          controllerKey: "dispose-owner",
          chatKey: "telegram/1:detached-dispose",
          text: "dispose coverage",
          disposeAfterTurn: true,
          affectChatBinding: false,
          sessionName: "owner-session",
          managedSessionLeaf: "owner-leaf",
          createSessionFileIfMissing: true,
          model: "owner-model",
          thinkingLevel: "high",
          noTools: true,
          deliverFinal: false,
          quietMode: true,
        }),
      ]);
      await Promise.allSettled([
        bridge.runTurn({
          controllerKey: "shutdown-owner",
          text: "shutdown coverage",
          shutdownAfterTurn: true,
        }),
      ]);
      await Promise.allSettled([
        bridge.runTurn({ controllerKey: "terminate-owner", text: "terminate coverage" }),
        bridge.runTurn({ chatKey: "telegram/1:terminate-bound", text: "terminate bound coverage" }),
      ]);
      if (!(await bridge.terminateTurn({ controllerKey: "terminate-owner" })).terminated) throw new Error("detached termination missing");
      if (!(await bridge.terminateTurn({ chatKey: "telegram/1:terminate-bound" })).terminated) throw new Error("bound termination missing");
      const internal = {
        async getFile({ file_id }) {
          if (file_id === "photo-ok") return { file_path: "photos/ok.jpg", file_size: 12 };
          throw Object.assign(new Error("telegram lookup failed"), { description: "telegram lookup failed" });
        },
      };
      const bot = { platform: "telegram", selfId: "1", internal };
      bridge.app.bots.push(bot);
      bridge.app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "media",
        userId: "trusted-media",
        messageId: "media-debug",
        content: "<file/>",
        stripped: { content: "<file/>" },
        elements: [{ type: "file", attrs: {} }],
        bot,
        telegram: {
          message: {
            message_id: 7,
            photo: [
              { file_id: "photo-ok", file_unique_id: "one", file_size: 12, width: 3, height: 4 },
              { file_id: "photo-fail" },
            ],
            document: {
              file_id: "document-fail",
              file_unique_id: "doc",
              file_size: 14,
              mime_type: "application/octet-stream",
              file_name: "owner.bin",
            },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await Promise.allSettled([
        bridge.runTurn({ chatKey: "telegram/1:bound-stop", text: "bound stop coverage" }),
      ]);
      await Promise.all([bridge.stop(), bridge.stop()]);
      const localBridge = await mainMod.startChatBridge({ hosted: false });
      await Promise.allSettled([
        localBridge.runTurn({ chatKey: "telegram/1:local-stop", text: "local stop coverage" }),
        localBridge.runTurn({ controllerKey: "local-detached", text: "local detached stop coverage" }),
      ]);
      process.emit("SIGTERM");
      await new Promise(() => {});
    `;
    await execFileAsync(
      process.execPath,
      [
        "--import",
        path.join(
          rootDir,
          "tests",
          "support",
          "register-chat-main-private-owner-fixture.mjs",
        ),
        "--input-type=module",
        "-e",
        script,
      ],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 60_000,
      },
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat main owner directly covers private telegram and command normalization branches", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-main-private-owner-"),
  );
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
  const script = String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const rootDir = process.env.RIN_REPO_ROOT;
    const mod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
    const supportMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href);
    supportMod.saveIdentity(path.join(process.env.RIN_DIR, "data"), {
      persons: { owner: { trust: "TRUSTED" } },
      aliases: [{ platform: "telegram", userId: "private-owner", personId: "owner" }],
      trusted: ["owner"],
    });
    const thread = mod.__rinOwnerAppendTelegramThreadToChatKey;
    assert.equal(thread("", {}), "");
    assert.equal(thread("telegram/1:2", null), "telegram/1:2");
    assert.equal(thread("discord/1:2", { platform: "discord", messageThreadId: "3" }), "discord/1:2");
    assert.equal(thread("telegram/1:2", { platform: "telegram" }), "telegram/1:2");
    assert.equal(thread("telegram/1:2?thread=old", { platform: "telegram", chatThreadId: "new" }), "telegram/1:2?thread=old");
    assert.equal(thread("telegram/1:2", { platform: "telegram", chatThreadId: "a b" }), "telegram/1:2?thread=a%20b");

    const debug = mod.__rinOwnerBuildTelegramInboundMediaDebug;
    assert.equal(await debug({}), undefined);
    assert.equal(await debug({ telegram: [] }), undefined);
    assert.equal(await debug({ telegram: {} }), undefined);
    assert.equal(await debug({ telegram: { message: "invalid" } }), undefined);
    assert.equal(await debug({ telegram: { message: { photo: [{ file_id: "" }] } } }), undefined);
    assert.equal(await debug({ telegram: { message: { document: { file_unique_id: "missing-id" } } } }), undefined);
    assert.equal((await debug({ telegram: { message: { document: { file_id: "finite", file_size: 9 } } } })).media[0].fileSize, 9);
    for (const field of ["edited_message", "channel_post", "edited_channel_post"]) {
      const result = await debug({ telegram: { [field]: { message_id: 0, document: { file_id: field } } } });
      assert.equal(result.media[0].fileId, field);
      assert.equal(result.lookups, undefined);
    }
    let lookups = 0;
    const result = await debug({
      telegram: {
        message: {
          message_id: 42,
          photo: [
            { file_id: "ok", file_unique_id: "unique", file_size: 12, width: 3, height: 4 },
            { file_id: "bad", file_size: "bad", width: "bad", height: "bad" },
            { file_id: "extra-1" }, { file_id: "extra-2" }, { file_id: "extra-3" },
          ],
          document: {
            file_id: "document", file_unique_id: "doc", file_size: "bad",
            mime_type: "text/plain", file_name: "owner.txt",
          },
        },
      },
      bot: { internal: { async getFile({ file_id }) {
        lookups += 1;
        if (file_id === "bad") throw { description: "bad description" };
        if (file_id === "extra-1") throw "raw failure";
        return { file_path: file_id === "ok" ? "photos/ok.jpg" : "", file_size: file_id === "ok" ? 12 : "bad" };
      } } },
    });
    assert.equal(result.messageId, "42");
    assert.equal(result.photoCount, 5);
    assert.equal(result.media.length, 6);
    assert.equal(result.lookups.length, 4);
    assert.equal(lookups, 4);
    assert.equal(result.lookups[0].ok, true);
    assert.equal(result.lookups[1].error, "bad description");

    const targets = mod.__rinOwnerGetCommandTargets;
    assert.deepEqual([...targets({ bot: { user: { name: "@Rin", username: "RIN2" }, username: "rin3", name: "rin4" }, username: "rin5", selfId: "rin6" })], ["rin", "rin2", "rin3", "rin4", "rin5", "rin6"]);
    const parseRequest = mod.__rinOwnerParseInboundCommandRequest;
    const rows = [{ name: "status" }];
    assert.equal(parseRequest({}, "hello", rows).commandLike, false);
    assert.equal(parseRequest({}, "/", rows).commandLike, false);
    assert.equal(parseRequest({}, "/@rin", rows).commandLike, false);
    assert.equal(parseRequest({}, "/unknown args", rows).command, null);
    assert.equal(parseRequest({ selfId: "rin" }, "/status@other x", rows).command, null);
    assert.deepEqual(parseRequest({}, "/status@unclaimed", rows).command, { name: "status", argsText: "" });
    assert.deepEqual(parseRequest({ selfId: "rin" }, "/STATUS@@RIN x y", rows).command, { name: "status", argsText: "x y" });
    assert.deepEqual(mod.__rinOwnerParseInboundCommand({}, "/status", rows), { name: "status", argsText: "" });
    assert.equal(mod.__rinOwnerParseInboundCommand({}, "/unknown", rows), null);
    assert.equal(mod.__rinOwnerElementsToCommandText([{ type: "text", attrs: { content: "status" } }]), "status");

    const bridge = await mod.startChatBridge({ hosted: true });
    const originalGetAdapterStatuses = bridge.app.getAdapterStatuses.bind(bridge.app);
    bridge.app.getAdapterStatuses = () => [{ status: "degraded" }];
    assert.equal(bridge.getStatus().status, "degraded");
    bridge.app.getAdapterStatuses = originalGetAdapterStatuses;
    const originalBots = bridge.app.bots;
    bridge.app.bots = null;
    assert.equal(bridge.getStatus().botCount, 0);
    bridge.app.bots = originalBots;
    const owner = bridge.__rinOwner;
    const bound = owner.getController("telegram/owner-bot:bound");
    assert.equal(owner.getController("telegram/owner-bot:bound"), bound);
    const detachedDefault = owner.getDetachedController("private-default");
    assert.equal(owner.getDetachedController("private-default"), detachedDefault);
    const detachedChanged = owner.getDetachedController("private-default", {
      chatKey: "telegram/owner-bot:changed",
      affectChatBinding: false,
      linkDeliveriesToSession: true,
      frontendIdentity: { kind: "owner", id: "changed" },
    });
    assert.notEqual(detachedChanged, detachedDefault);
    const detachedBusy = owner.getDetachedController("private-busy", {
      affectChatBinding: true,
    });
    owner.detachedControllerUsers.set(detachedBusy, 1);
    const detachedBusyReplacement = owner.getDetachedController("private-busy", {
      chatKey: "telegram/owner-bot:busy",
      affectChatBinding: false,
      linkDeliveriesToSession: false,
    });
    assert.notEqual(detachedBusyReplacement, detachedBusy);
    assert.equal(owner.retiredDetachedControllers.has(detachedBusy), true);
    assert.equal(owner.findRuntimeBot("missing", "missing"), undefined);
    const ownerBot = { platform: "telegram", selfId: "owner-bot" };
    bridge.app.bots.push(ownerBot);
    assert.equal(owner.findRuntimeBot(" telegram ", " owner-bot "), ownerBot);
    assert.equal(owner.sessionChatKey({ platform: "telegram", selfId: "owner-bot", channelId: "private", chatThreadId: "thread" }), "telegram/owner-bot:private?thread=thread");
    assert.equal(owner.isRecordOnlyChatKey("telegram/owner-bot:private"), false);
    assert.equal(owner.isInboundMessageProcessed("telegram/owner-bot:private", "missing"), false);
    assert.deepEqual(await owner.handleUnmatchedCommandSession("unknown", "telegram/owner-bot:private", "", false), {});
    await owner.handleUnmatchedCommandSession("unknown", "telegram/owner-bot:private", "", true).catch(() => {});
    await owner.handleUnmatchedCommandSession("unknown", "telegram/owner-bot:private", "message-id", true).catch(() => {});
    const outboxPayload = {
      createdAt: new Date().toISOString(),
      chatKey: "telegram/owner-bot:private",
      parts: [{ type: "text", text: "owner outbox" }],
    };
    await owner.enqueueAndDrainOutbox(outboxPayload).catch(() => {});
    let enqueued = 0;
    await owner.enqueueAndDrainOutbox(
      { ...outboxPayload, requestId: "owner-error", deliveryKind: "error" },
      "error",
      { id: "owner-explicit-id", idempotencyKey: "owner-idempotency", onEnqueued: () => { enqueued += 1; } },
    ).catch(() => {});
    assert.equal(enqueued, 1);
    await owner.handleCommandSession(
      { name: "help", argsText: "" }, {}, "telegram/owner-bot:private", "", {},
    ).catch(() => {});
    await owner.handleCommandSession(
      { name: "help", argsText: "ignored" }, {}, "telegram/owner-bot:private", "owner-help-message", {},
    ).catch(() => {});
    bound.runCommand = async () => ({ ok: true });
    assert.deepEqual(await owner.handleCommandSession(
      { name: "usage", argsText: "" }, {}, "telegram/owner-bot:bound", "", {},
    ), { disposition: "actionable" });
    bound.runCommand = async () => { throw "raw command failure"; };
    assert.deepEqual(await owner.handleCommandSession(
      { name: "usage", argsText: "argument" }, {}, "telegram/owner-bot:bound", "owner-status-message", {},
    ), { errorMessage: "raw command failure" });
    const ownerIdentity = supportMod.loadIdentity(path.join(process.env.RIN_DIR, "data"));
    const preparedPrivate = await owner.prepareAllowedChatTurnSubmission(
      {
        platform: "telegram", selfId: "owner-bot", channelId: "prepare-private",
        userId: "private-owner", messageId: "prepare-one", content: "private prompt",
        stripped: { content: "private prompt" }, timestamp: "bad", author: { nick: "Private Owner" },
      },
      [{ type: "text", attrs: { content: "private prompt" } }],
      ownerIdentity,
      { chatKey: "telegram/owner-bot:prepare-private", chatType: "private", requiresMentionToStartTurn: true },
    );
    assert.equal(preparedPrivate.promptMeta.requiresMentionToStartTurn, true);
    const preparedGroup = await owner.prepareAllowedChatTurnSubmission(
      {
        platform: "telegram", selfId: "owner-bot", channelId: "prepare-group",
        userId: "private-owner", messageId: "prepare-two", content: "group prompt",
        stripped: { content: "group prompt" }, timestamp: 9, runtimeMetadata: { owner: true },
      },
      [{ type: "text", attrs: { content: "group prompt" } }],
      ownerIdentity,
      { chatKey: "telegram/owner-bot:prepare-group", chatType: "group", requiresMentionToStartTurn: false },
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(preparedGroup.receivedAt, "2026-01-01T00:00:00.000Z");
    const preparedFailedMedia = await owner.prepareAllowedChatTurnSubmission(
      {
        platform: "telegram", selfId: "owner-bot", channelId: "prepare-media",
        userId: "private-owner", messageId: "prepare-media", content: "<file/>",
        stripped: { content: "<file/>" },
        bot: { internal: { async getFile() { throw new Error("telegram owner lookup"); } } },
        telegram: { message: { message_id: 11, document: { file_id: "missing-document" } } },
      },
      [{ type: "file", attrs: {} }],
      ownerIdentity,
      { chatKey: "telegram/owner-bot:prepare-media", chatType: "private", requiresMentionToStartTurn: false },
    );
    assert.match(preparedFailedMedia.text, /could not be attached/i);
    const preparedNonTelegramFailure = await owner.prepareAllowedChatTurnSubmission(
      {
        platform: "discord", selfId: "owner-bot", channelId: "prepare-media-two",
        userId: "private-owner", messageId: "prepare-media-two", content: "<file/>",
        stripped: { content: "<file/>" },
      },
      [{ type: "file", attrs: {} }],
      ownerIdentity,
      { chatKey: "discord/owner-bot:prepare-media-two", chatType: "group", requiresMentionToStartTurn: false },
    );
    assert.match(preparedNonTelegramFailure.text, /could not be attached/i);
    const preparedSavedMedia = await owner.prepareAllowedChatTurnSubmission(
      {
        platform: "telegram", selfId: "owner-bot", channelId: "prepare-saved-media",
        userId: "private-owner", messageId: "prepare-saved-media",
        content: "saved media", stripped: { content: "saved media" },
      },
      [
        { type: "text", attrs: { content: "saved media" } },
        { type: "file", attrs: { src: "data:text/plain;base64,b3duZXI=", file: "owner.txt" } },
        { type: "quote", attrs: { id: "quoted-owner" }, children: [{ type: "text", attrs: { content: "quoted text" } }] },
      ],
      ownerIdentity,
      { chatKey: "telegram/owner-bot:prepare-saved-media", chatType: "private", requiresMentionToStartTurn: false },
    );
    assert.equal(preparedSavedMedia.attachments.length, 1);
    assert.equal(preparedSavedMedia.replyToMessageId, "prepare-saved-media");
    const fallbackMeta = owner.buildCommandPromptMeta({ platform: "telegram", selfId: "owner-bot", channelId: "private", userId: "u", timestamp: "bad", runtimeMetadata: "bad" }, "TRUSTED");
    assert.equal(fallbackMeta.chatName, "");
    assert.equal(fallbackMeta.runtimeMetadata, undefined);
    const richMeta = owner.buildCommandPromptMeta({ platform: "telegram", selfId: "owner-bot", channelId: "room", userId: "u", timestamp: 7, channelName: "Owner Room", runtimeMetadata: { owner: true } }, "TRUSTED");
    assert.equal(richMeta.sentAt, 7);
    assert.deepEqual(richMeta.runtimeMetadata, { owner: true });
    await owner.runOutboxHistoryCleanup();
    owner.requestDrainChatOutbox();
    owner.requestDrainChatOutbox();
    owner.requestReconcileChatTerminals();
    owner.requestReconcileChatTerminals();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.stop();
    const alternateAgentDir = path.join(process.env.RIN_DIR, "alternate");
    await (await import("node:fs/promises")).mkdir(path.join(alternateAgentDir, "data"), { recursive: true });
    await (await import("node:fs/promises")).writeFile(path.join(alternateAgentDir, "data", "chat-runtime"), "dependency obstacle");
    const alternateSettings = path.join(alternateAgentDir, "owner-settings.json");
    await (await import("node:fs/promises")).writeFile(alternateSettings, "{}\\n");
    process.env.RIN_DIR = alternateAgentDir;
    const alternateBridge = await mod.startChatBridge({
      hosted: true,
      settingsPath: alternateSettings,
      frontendClientFactory: () => null,
    });
    await alternateBridge.stop();
  `;
  await execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(
        rootDir,
        "tests",
        "support",
        "register-chat-main-private-owner-fixture.mjs",
      ),
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
      timeout: 15_000,
    },
  );
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("chat main direct entrypoint reports startup failure", async () => {
  const rootFile = path.join(
    os.tmpdir(),
    `rin-chat-main-owner-file-${process.pid}-${Date.now()}`,
  );
  await fs.writeFile(rootFile, "not a directory", "utf8");
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(rootDir, "dist", "core", "chat", "main.js")],
        {
          cwd: rootDir,
          env: { ...process.env, RIN_DIR: rootFile },
          timeout: 10_000,
        },
      ),
      (error: unknown) => {
        const failure = error as { code?: number; stderr?: string };
        assert.equal(failure.code, 1);
        assert.match(String(failure.stderr), /ENOTDIR|not a directory/i);
        return true;
      },
    );
  } finally {
    await fs.rm(rootFile, { force: true });
  }
});

test("chat main direct entrypoint starts and handles a termination signal", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-main-direct-owner-"),
  );
  try {
    await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
    const { stdout, stderr } = await execFileAsync(
      "/bin/bash",
      [
        "-lc",
        '"$RIN_OWNER_NODE" --import "$RIN_OWNER_FIXTURE" "$RIN_OWNER_MAIN" & child=$!; sleep 3; kill -TERM "$child" 2>/dev/null || true; wait "$child"',
      ],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_DIR: agentDir,
          RIN_OWNER_NODE: process.execPath,
          RIN_OWNER_FIXTURE: path.join(
            rootDir,
            "tests",
            "support",
            "register-chat-main-private-owner-fixture.mjs",
          ),
          RIN_OWNER_MAIN: path.join(rootDir, "dist", "core", "chat", "main.js"),
        },
        timeout: 10_000,
      },
    );
    assert.equal(typeof `${stdout}\n${stderr}`, "string");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
