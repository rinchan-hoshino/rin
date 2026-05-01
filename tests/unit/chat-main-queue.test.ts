import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

test("chat main consumes inbound localized help messages through the inbox path only once", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ language: "zh-CN" }) + "\n",
      "utf8",
    );

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
        userId: "u1",
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
      if (
        rows.length !== 1 ||
        !text.includes("/help — \u663e\u793a\u53ef\u7528\u547d\u4ee4") ||
        !text.includes("/model — \u663e\u793a\u6216\u5207\u6362\u5f53\u524d\u6a21\u578b")
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

test("chat main treats /resume as a normal prompt after the command is removed", async () => {
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
        seen.push({
          mode,
          text: input?.text || null,
          replyToMessageId: input?.replyToMessageId || null,
          sessionFile: input?.sessionFile || null,
        });
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
        messageId: "m-resume",
        isDirect: true,
        content: "/resume",
        stripped: { content: "/resume" },
        elements: [h.createChatRuntimeH().text("/resume")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (
        runCommandCalls !== 0 ||
        sentCount !== 0 ||
        seen.length !== 1 ||
        seen[0]?.mode !== "prompt" ||
        seen[0]?.text !== "/resume" ||
        seen[0]?.replyToMessageId !== "m-resume" ||
        seen[0]?.sessionFile !== null
      ) {
        throw new Error(JSON.stringify({ sentCount, runCommandCalls, seen }));
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

test("chat main forwards command sender identity to controller prompt context", async () => {
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
        elements: [h.createChatRuntimeH().text("/new")],
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
        call.promptMeta?.source !== "chat-bridge" ||
        call.promptMeta?.triggerKind !== "chat-command" ||
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

test("chat main ignores removed /auth commands instead of mutating chat identity", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (newSessionCalls.length !== baselineNewSessionCalls) {
        throw new Error(JSON.stringify({ stage: "new-before-accepted", newSessionCalls }));
      }
      releasePromptStart();

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

test("chat main lets /abort bypass a same-chat turn waiting for backend admission", async () => {
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
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      controllerMod.ChatController.prototype.runActiveVoiceAcknowledgement = async function (commandName) {
        if (commandName !== "abort") throw new Error(commandName);
        return "Active voice abort reply.";
      };

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
            getSessionFile: () => "/tmp/abort-admission-chat.jsonl",
            getSessionId: () => "abort-admission-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/abort-admission-chat.jsonl",
            sessionId: "abort-admission-session",
          }),
          agent: {
            abort: () => {
              abortCalls += 1;
              controller.session.isStreaming = false;
            },
          },
          prompt: async (message, options = {}) => {
            promptTags.push(options.requestTag || "");
            if (message === "Briefly tell me the current operation was aborted.") {
              controller.session.isStreaming = false;
              await controller.handleClientEvent({
                type: "ui",
                payload: {
                  type: "rpc_turn_event",
                  event: "complete",
                  requestTag: options.requestTag,
                  finalText: "Active voice abort reply.",
                  result: { messages: [{ type: "text", text: "Active voice abort reply." }] },
                  sessionId: "abort-admission-session",
                  sessionFile: "/tmp/abort-admission-chat.jsonl",
                },
              });
              return;
            }
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

      app.emit("message", makeMessage("m-active", "start long turn"));
      const promptDeadline = Date.now() + 5000;
      while (Date.now() < promptDeadline && promptTags.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (promptTags.length !== 1) {
        throw new Error(JSON.stringify({ stage: "prompt-not-started", promptTags }));
      }

      app.emit("message", makeMessage("m-abort", "/abort"));
      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (abortCalls > 0 && rows.some((item) => item.text === "Active voice abort reply.")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        abortCalls !== 1 ||
        !rows.some((item) => item.text === "Active voice abort reply.")
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

test("chat main lets same-chat follow-up enter the chatKey worker as steer", async () => {
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
            if (options.streamingBehavior === "steer") return;
            controller.session.isStreaming = true;
            await controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "start",
                requestTag: options.requestTag,
              },
            });
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

      if (promptModes.length !== 2 || promptModes[0] !== "prompt" || promptModes[1] !== "steer") {
        throw new Error(JSON.stringify({ promptModes }));
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

test("chat main retries a transient daemon startup failure without leaking the socket error into chat", async () => {
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
      const leaked = rows.some((item) => String(item.text || "").includes("ENOENT"));
      const succeeded = rows.some((item) => item.text === "retry reply");
      if (!succeeded || leaked || connectCalls < 2) {
        throw new Error(JSON.stringify({ connectCalls, leaked, rows }));
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

test("chat main retries a disposed frontend turn without leaking the dispose error into chat", async () => {
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
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const originalRunTurn = controllerMod.ChatController.prototype.runTurn;
      let runTurnCalls = 0;
      let connectCalls = 0;
      controllerMod.ChatController.prototype.connect = async function () {
        connectCalls += 1;
        if (this.session && this.client) return;
        const controller = this;
        this.client = { subscribe() {} };
        this.session = {
          isStreaming: false,
          messages: [],
          sessionManager: {
            getSessionFile: () => "/tmp/dispose-retry-chat.jsonl",
            getSessionId: () => "dispose-retry-session",
            getSessionName: () => controller.chatKey,
          },
          ensureSessionReady: async () => ({
            sessionFile: "/tmp/dispose-retry-chat.jsonl",
            sessionId: "dispose-retry-session",
          }),
          prompt: async (_message, options = {}) => {
            controller.handleClientEvent({
              type: "ui",
              payload: {
                type: "rpc_turn_event",
                event: "complete",
                requestTag: options.requestTag,
                finalText: "retry after dispose",
                result: { messages: [{ type: "text", text: "retry after dispose" }] },
                sessionId: "dispose-retry-session",
                sessionFile: "/tmp/dispose-retry-chat.jsonl",
              },
            });
          },
          switchSession: async () => {},
        };
      };
      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        runTurnCalls += 1;
        if (runTurnCalls === 1) {
          throw new Error("chat_frontend_driver_disposed");
        }
        return await originalRunTurn.call(this, input, mode);
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
        messageId: "m-dispose-retry",
        isDirect: true,
        content: "hello dispose retry",
        stripped: { content: "hello dispose retry" },
        elements: [h.createChatRuntimeH().text("hello dispose retry")],
      });

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.some((item) => item.text === "retry after dispose")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const rows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      const leaked = rows.some((item) => String(item.text || "").includes("disposed"));
      const succeeded = rows.some((item) => item.text === "retry after dispose");
      if (!succeeded || leaked || runTurnCalls < 2 || connectCalls < 1) {
        throw new Error(JSON.stringify({ runTurnCalls, connectCalls, leaked, rows }));
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

test("chat main retries an offline-queued frontend turn without leaking the disconnect error into chat", async () => {
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
      const leaked = rows.some((item) => String(item.text || "").includes("queued_offline"));
      const succeeded = rows.some((item) => item.text === "retry after queued offline");
      if (!succeeded || leaked || runTurnCalls < 2) {
        throw new Error(JSON.stringify({ runTurnCalls, leaked, rows }));
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

test("chat main passes quoted reply session metadata through one normal prompt submission", async () => {
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
        quote: {
          messageId: "m-linked",
          content: "old reply",
        },
        elements: [h.createChatRuntimeH().text("continue here")],
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
        first.mode !== "prompt" ||
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

test("chat main bridges same-user quoted group message without a session as the prompt body", async () => {
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
        quote: {
          messageId: "m-rich-source",
          userId: "owner-1",
          content: "look at this image",
        },
        elements: [node.at("1", { name: "rin_bot" })],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) throw new Error(JSON.stringify({ seen }));
      const first = seen[0];
      if (
        first.mode !== "prompt" ||
        first.sessionFile !== null ||
        first.replyToMessageId !== "m-mention-quote" ||
        !first.text.includes("look at this image") ||
        !first.text.includes("[image: cat.png](https://example.com/cat.png)")
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
        quote: {
          messageId: "m-linked",
          content: "old reply",
        },
        elements: [h.createChatRuntimeH().text("continue here")],
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (seen.length !== 1) {
        throw new Error(JSON.stringify({ seen, replySessionFile }));
      }
      const [first] = seen;
      if (
        first.mode !== "prompt" ||
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
