import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

await import("../support/register-chat-main-platform-owner-fixture.ts");
const main = (await import(
  pathToFileURL(path.resolve("dist/core/chat/main.js")).href
)) as any;
const { Chat } = await import(
  pathToFileURL(path.resolve("dist/core/chat/chat.js")).href
);

const validBot = {
  platform: "example",
  selfId: "bot",
  async sendMessage() {
    return [];
  },
};

test("Chat main validates and loads ordinary Pi platform contributions", async () => {
  assert.equal(main.__rinOwnerIsChatPlatformContribution(null), false);
  assert.equal(main.__rinOwnerIsChatPlatformContribution({}), false);
  assert.equal(
    main.__rinOwnerIsChatPlatformContribution({
      apiVersion: 1,
      platform: "Example!",
      create() {},
    }),
    false,
  );
  assert.equal(
    main.__rinOwnerIsChatPlatformContribution({
      apiVersion: 1,
      platform: "example",
      create() {},
    }),
    true,
  );
  assert.equal(main.__rinOwnerIsChatPlatform(null), false);
  assert.equal(main.__rinOwnerIsChatPlatform({ bot: validBot }), false);
  assert.equal(
    main.__rinOwnerIsChatPlatform({ bot: validBot, start() {}, stop() {} }),
    true,
  );

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-platform-extension-"),
  );
  try {
    const extensionPath = path.join(root, "platform.mjs");
    await fs.writeFile(
      extensionPath,
      `export default function (pi) {
        const emit = (value) => pi.events.emit("rin.chat.platform.v1", value);
        emit(null);
        emit({ apiVersion: 1, platform: "example", defaults: { endpoint: "default" }, create: async (input) => {
          input.logger.debug("owner external debug");
          input.logger.error("owner external error");
          input.receive({ platform: "example", selfId: "bot" });
          input.updateStatus({ platform: "example", selfId: "bot" }, "ready");
          input.composeKey("chat", "bot");
          input.beginRecovery("example/bot:chat");
          input.completeRecovery("example/bot:chat");
          await input.recoverInbound("bot", async () => []);
          return {
            bot: { platform: "example", selfId: "bot", sendMessage: async () => [] },
            start() {}, stop() {}
          };
        } });
        emit({ apiVersion: 1, platform: "example", create: async () => null });
        emit({ apiVersion: 1, platform: "broken", create: async () => null });
        emit({ apiVersion: 1, platform: "mismatch", create: async () => ({
          bot: { platform: "other", selfId: "bot", sendMessage: async () => [] },
          start() {}, stop() {}
        }) });
        emit({ apiVersion: 1, platform: "throws", create: async () => { throw new Error("owner create failed"); } });
      }`,
      "utf8",
    );

    const contributions =
      await main.__rinOwnerLoadExternalChatPlatformContributions({
        cwd: root,
        agentDir: root,
        additionalExtensionPaths: [
          extensionPath,
          path.join(root, "missing.mjs"),
        ],
      });
    assert.deepEqual(
      contributions.map((entry: any) => entry.platform),
      ["example", "broken", "mismatch", "throws"],
    );

    const chat = new Chat();
    await main.__rinOwnerAddExternalChatPlatforms(chat, {
      cwd: root,
      agentDir: root,
      dataDir: root,
      additionalExtensionPaths: [extensionPath],
      settings: {
        chat: {
          example: {},
          broken: {},
          mismatch: {},
          throws: {},
        },
      },
    });
    const statuses = chat.getPlatformStatuses();
    assert.equal(
      statuses.some((entry: any) => entry.platform === "example"),
      true,
    );
    assert.equal(
      statuses.filter((entry: any) => entry.status === "degraded").length,
      3,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
