import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(import.meta.dirname, "..", "..");

test("dedicated owner chat becomes one shallow nerve stimulus without a Chat Agent turn", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-nerve-"));
  try {
    const script = `
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const root = process.env.RIN_REPO_ROOT;
      const agentDir = process.env.RIN_DIR;
      const main = await import(pathToFileURL(path.join(root, "dist/core/chat/main.js")).href);
      const controller = await import(pathToFileURL(path.join(root, "dist/core/chat/controller.js")).href);
      const inbox = await import(pathToFileURL(path.join(root, "dist/core/chat/inbox.js")).href);
      const support = await import(pathToFileURL(path.join(root, "dist/core/chat/support.js")).href);
      const chat = await import(pathToFileURL(path.join(root, "dist/core/chat/chat.js")).href);

      support.saveIdentity(path.join(agentDir, "data"), {
        persons: { owner: { trust: "OWNER" } },
        aliases: [{ platform: "telegram", userId: "owner-1", personId: "owner" }],
        trusted: [],
      });

      let runTurnCalls = 0;
      controller.ChatController.prototype.runTurn = async function () {
        runTurnCalls += 1;
      };
      const observations = [];
      const { app } = await main.startChatBridge({
        commandRows: [{ name: "help", description: "help" }],
        nerveObserver: {
          ownerChatKey: "telegram/1:2",
          observe: async (value) => {
            observations.push(value);
            return { handled: true, stimulated: true };
          },
        },
      });
      app.bots.push({ platform: "telegram", selfId: "1", async sendMessage() { return []; } });
      const emit = (userId, messageId, content) => app.emit("message", {
        platform: "telegram", selfId: "1", channelId: "2", userId,
        author: { name: "Owner Name" }, messageId, isDirect: false, content, stripped: { content },
        elements: [chat.createChatNodes().text(content)],
      });
      emit("owner-1", "owner-message", "/help");
      emit("other", "other-message", "do not wake");

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const items = inbox.listChatInboxItems(agentDir, ["terminal"]);
        if (items.some((item) => item.messageId === "owner-message") &&
            items.some((item) => item.messageId === "other-message")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      process.stdout.write("\\n__NERVE_RESULT__" + JSON.stringify({ observations, runTurnCalls }));
      process.exit(0);
    `;
    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: { ...process.env, RIN_REPO_ROOT: rootDir, RIN_DIR: agentDir },
        timeout: 15_000,
      },
    );
    const marker = "__NERVE_RESULT__";
    const output = JSON.parse(
      result.stdout.slice(result.stdout.lastIndexOf(marker) + marker.length),
    );
    assert.equal(output.runTurnCalls, 0);
    assert.equal(output.observations.length, 1);
    assert.equal(output.observations[0].chatKey, "telegram/1:2");
    assert.equal(output.observations[0].messageId, "owner-message");
    assert.equal(output.observations[0].trust, "OWNER");
    assert.equal(output.observations[0].body, "Telegram · Owner Name\n/help");
    assert.equal("context" in output.observations[0], false);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
