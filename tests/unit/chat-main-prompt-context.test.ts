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

test("chat main carries sender metadata to the controller with the prompt body", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(path.join(tempRoot, "rin-chat-main-meta-"));
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
      const h = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat-runtime", "index.js")).href);
      const seen = [];

      supportMod.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" }, guest: { trust: "TRUSTED" } },
        aliases: [
          { platform: "telegram", userId: "owner-1", personId: "owner" },
          { platform: "telegram", userId: "guest-1", personId: "guest" },
        ],
        trusted: [],
      });

      controllerMod.ChatController.prototype.runTurn = async function (input, mode) {
        seen.push({ mode, text: input?.text || "", promptMeta: input?.promptMeta || null });
        return { retry: false };
      };

      const { app } = await mainMod.startChatBridge();
      app.bots.push({
        platform: "telegram",
        selfId: "1",
        internal: {
          async getChatMember({ user_id }) {
            return user_id === "owner-1" ? { status: "member" } : { status: "left" };
          },
        },
        async sendMessage() {
          return ["assistant-1"];
        },
      });

      app.emit("message", {
        platform: "telegram",
        selfId: "1",
        channelId: "2",
        guildId: "group-1",
        bot: {
          selfId: "1",
          username: "RinBot",
          internal: {
            async getChatMember({ user_id }) {
              return user_id === "owner-1" ? { status: "member" } : { status: "left" };
            },
          },
        },
        userId: "guest-1",
        author: {
          name: "GroupCard",
          nick: "GroupCard",
          groupNickname: "GroupCard",
          nickname: "AccountNick",
        },
        messageId: "m-identity",
        isDirect: false,
        content: "@RinBot my name is?",
        stripped: { content: "my name is?", appel: true },
        elements: [
          { type: "at", attrs: { name: "RinBot" } },
          h.createChatRuntimeH().text(" my name is?"),
        ],
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && seen.length < 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.log(JSON.stringify(seen));
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
    const rows = stdout
      .trim()
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("["));
    const seen = JSON.parse(rows.at(-1) || "[]");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].mode, undefined);
    assert.equal(seen[0].text, "my name is?");
    assert.equal(seen[0].promptMeta.source, "chat-bridge");
    assert.equal(seen[0].promptMeta.chatKey, "telegram:2");
    assert.equal(seen[0].promptMeta.userId, "guest-1");
    assert.equal(seen[0].promptMeta.nickname, "AccountNick");
    assert.equal(seen[0].promptMeta.groupNickname, undefined);
    assert.equal(seen[0].promptMeta.identity, "TRUSTED");
    assert.equal(seen[0].promptMeta.requiresMentionToStartTurn, true);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("chat controller passes sender metadata through the frontend prompt context", async () => {
  const tempRoot = "/home/rin/tmp";
  await fs.mkdir(tempRoot, { recursive: true });
  const agentDir = await fs.mkdtemp(
    path.join(tempRoot, "rin-chat-controller-meta-"),
  );
  try {
    const dataDir = path.join(agentDir, "data");
    await fs.mkdir(dataDir, { recursive: true });

    const script = String.raw`
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const rootDir = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const controllerMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js")).href);
      const dataDir = path.join(agentDir, "data");
      const seen = [];
      const controller = new controllerMod.ChatController(
        { bots: [] },
        dataDir,
        "cron/prompt:context",
        {
          logger: { warn() {}, info() {}, error() {} },
          h: {},
          affectChatBinding: false,
        },
      );
      controller.connect = async () => {};
      controller.driver = {
        async runTurn(input) {
          seen.push(input);
          return { finalText: "ok", result: {}, sessionFile: "/tmp/chat-meta.jsonl" };
        },
        currentSessionFile() {
          return "/tmp/chat-meta.jsonl";
        },
        currentSessionId() {
          return "chat-meta-session";
        },
      };
      await controller.runTurn({
        text: "my name is?",
        attachments: [],
        incomingMessageId: "m-identity",
        promptMeta: {
          source: "chat-bridge",
          chatKey: "telegram/1:2",
          chatType: "group",
          userId: "guest-1",
          nickname: "AccountNick",
          groupNickname: "GroupCard",
          identity: "TRUSTED",
        },
      });
      console.log(JSON.stringify(seen));
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
    const rows = stdout
      .trim()
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("["));
    const seen = JSON.parse(rows.at(-1) || "[]");
    assert.equal(seen.length, 1);
    assert.ok(seen[0].text.startsWith("time: "));
    assert.ok(seen[0].text.includes("runtime metadata: rin prompt context v1"));
    assert.ok(seen[0].text.includes("sender user id: guest-1"));
    assert.ok(seen[0].text.includes("sender nickname: AccountNick"));
    assert.equal(seen[0].text.includes("sender group nickname:"), false);
    assert.ok(seen[0].text.includes("sender trust: trusted user"));
    assert.ok(seen[0].text.endsWith("---\nmy name is?"));
    assert.deepEqual(seen[0].promptContext, {
      source: "chat-bridge",
      chatKey: "telegram/1:2",
      chatType: "group",
      userId: "guest-1",
      nickname: "AccountNick",
      groupNickname: "GroupCard",
      identity: "TRUSTED",
    });
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
