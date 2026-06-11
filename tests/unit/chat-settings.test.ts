import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatSettings = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "settings.js")).href
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);

test("chat settings normalization can force a writable chat object", () => {
  const normalized = chatSettings.normalizeStoredChatSettings(
    { chat: "broken" },
    { ensureChat: true },
  );

  assert.deepEqual(normalized, { chat: {} });
});

test("chat settings helper drops stray legacy adapter settings without creating chat", () => {
  const normalized = chatSettings.dropLegacyChatSettings({
    koishi: { telegram: { token: "legacy-token" } },
    keep: true,
  });

  assert.deepEqual(normalized, { keep: true });
});

test("chat turn policy defaults to starting turns on incoming messages", () => {
  assert.equal(
    chatSettings.resolveChatTurnPolicyMode({}, "telegram/123:456"),
    "start_on_message",
  );
  assert.equal(
    chatSettings.resolveChatTurnPolicyMode(
      { chat: { turnPolicy: { default: "unknown" } } },
      "telegram/123:456",
    ),
    "start_on_message",
  );
});

test("chat turn policy supports record-only per chat key", () => {
  const settings = {
    chat: {
      turnPolicy: { default: "start_on_message" },
      byChatKey: {
        "telegram/123:456": { turnPolicy: "record_only" },
      },
    },
  };

  assert.equal(
    chatSettings.resolveChatTurnPolicyMode(settings, "telegram/123:456"),
    "record_only",
  );
  assert.equal(
    chatSettings.resolveChatTurnPolicyMode(settings, "telegram/123:789"),
    "start_on_message",
  );
});

test("chat turn policy accepts object entries inside the per-chat config", () => {
  const settings = {
    chat: {
      byChatKey: {
        "telegram/123:456": {
          turnPolicy: { mode: "record_only", wakeTaskId: "ignored" },
        },
        "telegram/123:789": { turnPolicy: { mode: "start_on_message" } },
      },
    },
  };

  assert.equal(
    chatSettings.resolveChatTurnPolicyMode(settings, "telegram/123:456"),
    "record_only",
  );
  assert.equal(
    chatSettings.resolveChatTurnPolicyMode(settings, "telegram/123:789"),
    "start_on_message",
  );
});

test("chat quiet mode supports per-chat entries", () => {
  const settings = {
    chat: {
      quietMode: { default: false },
      byChatKey: {
        "telegram/123:456": { quietMode: true },
        "telegram/123:789": { quietMode: { enabled: true } },
        "telegram/123:000": { quietMode: { mode: "normal" } },
      },
    },
  };

  assert.equal(
    chatSettings.resolveChatQuietModeEnabled(settings, "telegram/123:456"),
    true,
  );
  assert.equal(
    chatSettings.resolveChatQuietModeEnabled(settings, "telegram/123:789"),
    true,
  );
  assert.equal(
    chatSettings.resolveChatQuietModeEnabled(settings, "telegram/123:000"),
    false,
  );
  assert.equal(
    chatSettings.resolveChatQuietModeEnabled(settings, "telegram/123:999"),
    false,
  );
});

test("chat support ignores removed legacy adapter settings keys", () => {
  const config = support.buildChatConfigFromSettings({
    koishi: {
      telegram: { token: "legacy-token" },
    },
  });

  assert.equal(config.plugins["adapter-telegram"], undefined);
});
