import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const setup = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat-bridge", "setup.js"))
    .href
);

function createPromptHarness(answers) {
  const queues = {
    select: [...(answers.select || [])],
    text: [...(answers.text || [])],
    confirm: [...(answers.confirm || [])],
  };
  return {
    ensureNotCancelled(value) {
      if (value === undefined || value === null) throw new Error("cancelled");
      return value;
    },
    async select() {
      return queues.select.shift();
    },
    async text(options) {
      const value = queues.text.shift();
      const validationError = options?.validate?.(String(value ?? ""));
      if (validationError) throw new Error(String(validationError));
      return value;
    },
    async confirm() {
      return queues.confirm.shift();
    },
  };
}

test("chat bridge setup configures Telegram with minimal polling defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["telegram"],
      text: ["123456:ABCDEF"],
    }),
  );

  assert.equal(result.adapterKey, "telegram");
  assert.equal(result.chatDescription, "Telegram");
  assert.deepEqual(result.chatConfig, {
    telegram: {
      token: "123456:ABCDEF",
      protocol: "polling",
      slash: true,
    },
  });
});

test("chat bridge setup configures Slack with socket mode defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["slack"],
      text: ["xapp-demo", "xoxb-demo"],
    }),
  );

  assert.equal(result.adapterKey, "slack");
  assert.equal(result.chatDescription, "Slack");
  assert.deepEqual(result.chatConfig, {
    slack: {
      protocol: "ws",
      token: "xapp-demo",
      botToken: "xoxb-demo",
    },
  });
});

test("chat bridge setup configures QQ with shared websocket defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["qq", "public"],
      text: ["qq-app-id", "qq-secret", "qq-token"],
    }),
  );

  assert.equal(result.adapterKey, "qq");
  assert.equal(result.chatDescription, "QQ");
  assert.deepEqual(result.chatConfig, {
    qq: {
      protocol: "websocket",
      sandbox: false,
      authType: "bearer",
      id: "qq-app-id",
      secret: "qq-secret",
      token: "qq-token",
      type: "public",
    },
  });
});

test("chat bridge setup infers OneBot HTTP mode and omits blank optional fields", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["onebot"],
      text: ["https://example.com/onebot", "", "   "],
    }),
  );

  assert.equal(result.adapterKey, "onebot");
  assert.equal(result.chatDescription, "OneBot");
  assert.deepEqual(result.chatConfig, {
    onebot: {
      endpoint: "https://example.com/onebot",
      protocol: "http",
    },
  });
});

test("chat bridge setup rejects unsupported OneBot URL protocols", async () => {
  await assert.rejects(
    setup.promptChatBridgeSetup(
      createPromptHarness({
        confirm: [true],
        select: ["onebot"],
        text: ["ftp://example.com/onebot", "", ""],
      }),
    ),
    /Use an http\(s\):\/\/ or ws\(s\):\/\/ URL\./,
  );
});

test("chat bridge setup configures Feishu / Lark with websocket defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["lark", "feishu"],
      text: ["cli_xxx", "secret_xxx"],
    }),
  );

  assert.equal(result.adapterKey, "lark");
  assert.equal(result.chatDescription, "Feishu / Lark");
  assert.deepEqual(result.chatConfig, {
    lark: {
      platform: "feishu",
      protocol: "ws",
      appId: "cli_xxx",
      appSecret: "secret_xxx",
    },
  });
});

test("chat bridge setup configures Minecraft / QueQiao with websocket defaults", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      confirm: [true],
      select: ["minecraft"],
      text: ["ws://127.0.0.1:8080", "minecraft", "Survival", "demo-token"],
    }),
  );

  assert.equal(result.adapterKey, "minecraft");
  assert.equal(result.chatDescription, "Minecraft / QueQiao");
  assert.deepEqual(result.chatConfig, {
    minecraft: {
      protocol: "ws",
      url: "ws://127.0.0.1:8080",
      selfId: "minecraft",
      serverName: "Survival",
      token: "demo-token",
    },
  });
});

test("chat bridge setup rejects non-websocket Minecraft URLs", async () => {
  await assert.rejects(
    setup.promptChatBridgeSetup(
      createPromptHarness({
        confirm: [true],
        select: ["minecraft"],
        text: [
          "https://example.com/bridge",
          "minecraft",
          "Survival",
          "demo-token",
        ],
      }),
    ),
    /Use a ws:\/\/ or wss:\/\/ URL\./,
  );
});

test("chat bridge setup can skip the installer yes-no gate", async () => {
  const result = await setup.promptChatBridgeSetup(
    createPromptHarness({
      select: ["telegram"],
      text: ["123456:ABCDEF"],
    }),
    { confirmEnable: false },
  );

  assert.equal(result.adapterKey, "telegram");
  assert.deepEqual(result.chatConfig, {
    telegram: {
      token: "123456:ABCDEF",
      protocol: "polling",
      slash: true,
    },
  });
});
