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

test("chat main consumes inbound localized help messages through the inbox path only once", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-main-queue-"),
  );
  try {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ language: "zh_CN" }) + "\n",
      "utf8",
    );

    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
      const storeMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href);
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
      if (
        rows.length !== 1 ||
        !text.includes("/help — \u663e\u793a\u53ef\u7528\u547d\u4ee4") ||
        !text.includes("/usage — \u663e\u793a\u7528\u91cf\u548c\u914d\u989d\u72b6\u6001") ||
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

      controllerMod.ChatController.prototype.runCommand = async function (commandLine, replyToMessageId, incomingMessageId, sessionFile, promptMeta) {
        seen.push({ commandLine, chatKey: this.chatKey, promptMeta });
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

test("chat main restores every stranded processing inbox item on startup", async () => {
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
      for (const filePath of inbox.listPendingChatInboxFiles(agentDir)) {
        inbox.claimChatInboxFile(agentDir, filePath);
      }
      if (inbox.listProcessingChatInboxFiles(agentDir).length !== 9) {
        throw new Error("processing_fixture_not_ready");
      }

      const bridge = await mainMod.startChatBridge();
      try {
        const deadline = Date.now() + 5000;
        let processingCount = Infinity;
        while (Date.now() < deadline) {
          processingCount = inbox.listProcessingChatInboxFiles(agentDir).length;
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

test("chat main reports unmatched private slash commands without starting an agent turn", async () => {
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
        messageId: "m-model-command",
        isDirect: true,
        content: "/model openai/gpt-5",
        stripped: { content: "/model openai/gpt-5" },
        elements: [h.createChatRuntimeH().text("/model openai/gpt-5")],
      });

      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = storeMod
          .listChatMessages(agentDir)
          .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (
        runCommandCalls !== 0 ||
        seen.length !== 0 ||
        sentCount !== 1 ||
        rows.length !== 1 ||
        rows[0]?.text !== "Unknown command. Send /help to see available commands."
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

test("chat main reports unmatched owner-only group slash commands like private chats", async () => {
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
        username: "rin_bot",
        name: "rin_bot",
        internal: {
          async getChatMemberCount({ chat_id }) {
            if (chat_id !== "-10042") throw new Error("unexpected chat " + chat_id);
            return 2;
          },
        },
        async sendMessage() {
          sentCount += 1;
          return [String(sentCount)];
        },
      });
      const node = h.createChatRuntimeH();
      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "-10042",
        guildId: "-10042",
        userId: "owner-1",
        messageId: "m-owner-only-unknown",
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
          .filter((item) => item.chatKey === "telegram/1:-10042" && item.role === "assistant");
        if (rows.length >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (
        runCommandCalls !== 0 ||
        seen.length !== 0 ||
        sentCount !== 1 ||
        rows.length !== 1 ||
        rows[0]?.text !== "Unknown command. Send /help to see available commands."
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
        elements: [h.createChatRuntimeH().text("/new")],
        quote: { messageId: "assistant-old" },
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

test("chat main submits same-chat follow-up as steer before the current turn is accepted", async () => {
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
            if (controller.session.isStreaming) return;
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

      const listInbox = (name) => {
        const dir = path.join(agentDir, "data", "chat", "inbox", name);
        return fs.existsSync(dir)
          ? fs.readdirSync(dir)
              .filter((entry) => entry.endsWith(".json"))
              .map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")))
          : [];
      };
      const pendingItems = listInbox("pending");
      const processingItems = listInbox("processing");
      const failedItems = listInbox("failed");
      if (promptModes.length !== 2 || promptModes[0] !== "prompt" || promptModes[1] !== "steer" || pendingItems.length || failedItems.length || processingItems.length < 1) {
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

test("chat main completes a steered inbox item after the inbound message is processed", async () => {
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
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      const listInbox = (name) => {
        const dir = path.join(agentDir, "data", "chat", "inbox", name);
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")) : [];
      };

      let runTurnCalls = 0;
      controllerMod.ChatController.prototype.runTurn = async function (input) {
        runTurnCalls += 1;
        setTimeout(() => {
          chatHelpersMod.markProcessedChatMessage(agentDir, this.chatKey, input.incomingMessageId, {
            acceptedAt: new Date().toISOString(),
            processedAt: new Date().toISOString(),
            sessionFile: "/tmp/delivered-steer.jsonl",
          });
        }, 100);
        return { steered: true, sessionFile: "/tmp/delivered-steer.jsonl" };
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
        content: "delivered steer",
        stripped: { content: "delivered steer" },
        elements: [h.createChatRuntimeH().text("delivered steer")],
      });

      const deadline = Date.now() + 5000;
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
        timeout: 15000,
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
      if (succeeded || !errorNotice || connectCalls !== 1) {
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

test("hosted chat bridge shutdown uses frontend SDK shutdown instead of controller dispose", async () => {
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
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      let shutdownCalls = 0;
      let disposeCalls = 0;
      let activeReject;
      controllerMod.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
        await new Promise((_resolve, reject) => {
          activeReject = reject;
        });
      };
      controllerMod.ChatController.prototype.shutdownSession = async function () {
        shutdownCalls += 1;
        activeReject?.(new Error("Request was aborted"));
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

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && runTurnCalls < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await bridge.stop();
      const pendingDir = path.join(agentDir, "data", "chat", "inbox", "pending");
      const failedDir = path.join(agentDir, "data", "chat", "inbox", "failed");
      const waitDeadline = Date.now() + 2000;
      while (Date.now() < waitDeadline) {
        const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((name) => name.endsWith(".json")) : [];
        if (pendingFiles.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((name) => name.endsWith(".json")) : [];
      const failedFiles = fs.existsSync(failedDir) ? fs.readdirSync(failedDir).filter((name) => name.endsWith(".json")) : [];
      const assistantRows = storeMod
        .listChatMessages(agentDir)
        .filter((item) => item.chatKey === "telegram/1:2" && item.role === "assistant");
      if (runTurnCalls !== 1 || shutdownCalls !== 1 || disposeCalls !== 0 || pendingFiles.length !== 1 || failedFiles.length !== 0 || assistantRows.length !== 0) {
        throw new Error(JSON.stringify({ runTurnCalls, shutdownCalls, disposeCalls, pendingFiles, failedFiles, assistantRows }));
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

test("chat main omits reply metadata when quoting the latest assistant message", async () => {
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
        quote: {
          messageId: "m-latest-assistant",
          content: "latest assistant reply",
        },
        elements: [h.createChatRuntimeH().text("continue here")],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (seen.length !== 1) throw new Error(JSON.stringify({ seen }));
      const first = seen[0];
      if (
        first.mode !== undefined ||
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

test("chat main prepends own unsessioned quoted message to trigger text", async () => {
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
        quote: {
          messageId: "m-rich-source",
          userId: "owner-1",
          content: "look at this image",
        },
        elements: [
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

test("chat main uses own unsessioned quoted message as mention-only trigger text", async () => {
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
        quote: {
          messageId: "m-rich-source",
          userId: "owner-1",
          content: "quoted body should only be fetched explicitly",
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
        first.mode !== undefined ||
        first.sessionFile !== null ||
        first.replyToMessageId !== "m-mention-quote" ||
        first.promptMetaReplyTo !== null ||
        first.text !== "quoted body should only be fetched explicitly"
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
