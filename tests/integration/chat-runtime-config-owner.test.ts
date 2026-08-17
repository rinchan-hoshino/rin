import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const config = await importBuiltModule<
  typeof import("../../src/core/chat/runtime-config.js")
>("dist/core/chat/runtime-config.js");

test("Chat platform config normalizes single, named, and repeated accounts", () => {
  assert.deepEqual(config.listChatPlatformEntries({}, ""), []);
  assert.deepEqual(config.listChatPlatformEntries({}, "missing"), []);
  assert.deepEqual(
    config.listChatPlatformEntries(
      {
        chat: {
          example: [
            null,
            {
              name: " Owner account! ",
              enabled: true,
              owners: ["setup-only"],
              endpoint: "ws://example.invalid",
            },
            { enabled: false },
          ],
        },
      },
      " EXAMPLE ",
      { protocol: "ws", endpoint: "default" },
    ),
    [
      {
        platform: "example",
        name: "Owner-account-",
        config: {
          protocol: "ws",
          endpoint: "ws://example.invalid",
          enabled: true,
        },
      },
    ],
  );

  assert.deepEqual(
    config.listChatPlatformEntries(
      {
        chat: {
          example: {
            primary: { token: "one" },
            secondary: { name: "Second / account", token: "two" },
          },
        },
      },
      "example",
    ),
    [
      {
        platform: "example",
        name: "primary",
        config: { token: "one" },
      },
      {
        platform: "example",
        name: "Second-account",
        config: { token: "two" },
      },
    ],
  );
  assert.deepEqual(
    config.listChatPlatformEntries(
      { chat: { example: { endpoint: "ws://single.invalid", retries: 2 } } },
      "example",
    ),
    [
      {
        platform: "example",
        name: "example",
        config: { endpoint: "ws://single.invalid", retries: 2 },
      },
    ],
  );
});

test("built-in Chat platform config applies Telegram defaults only", () => {
  const entries = config.listBuiltInChatPlatformEntries({
    chat: {
      telegram: { token: "telegram-token", botId: "setup-only" },
      discord: {},
    },
  });
  assert.deepEqual(entries, [
    {
      platform: "telegram",
      name: "telegram",
      config: {
        protocol: "polling",
        slash: false,
        request: { timeout: 30000 },
        token: "telegram-token",
      },
    },
    { platform: "discord", name: "discord", config: {} },
  ]);
});
