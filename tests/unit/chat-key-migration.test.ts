import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const migration = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "chat-key-migration.js"),
  ).href
);

test("chat key migration infers configured bot ids without adapter-specific key shapes", () => {
  const botIds = migration.inferChatBotIdsFromSettings({
    chat: {
      telegram: { token: "8623230033:secret" },
      onebot: { selfId: "2301401877" },
      discord: { rin: { token: "MTUxOTkwODk1NjIxMjgyMjExNw.secret" } },
      minecraft: { selfId: "minecraft" },
    },
  });

  assert.deepEqual(botIds, {
    discord: "1519908956212822117",
    minecraft: "minecraft",
    onebot: "2301401877",
    telegram: "8623230033",
  });
});

test("chat key migration canonicalizes legacy unqualified keys through a single bot-qualified shape", () => {
  const botIds = {
    discord: "1519908956212822117",
    onebot: "2301401877",
    telegram: "8623230033",
  };

  assert.equal(
    migration.canonicalizeStoredChatKey("discord:1519918607071576239", botIds),
    "discord/1519908956212822117:1519918607071576239",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey("onebot:private:519418441", botIds),
    "onebot/2301401877:private:519418441",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey(
      "telegram/8623230033:-1001447529496",
      botIds,
    ),
    "telegram/8623230033:-1001447529496",
  );
  assert.equal(
    migration.canonicalizeStoredChatKey("matrix:!room:example.org", botIds),
    "",
  );
});

test("chat key migration rewrites byChatKey entries without losing settings", () => {
  const settings = {
    chat: {
      byChatKey: {
        "discord:1519918607071576239": { turnPolicy: "record_only" },
        "onebot/2301401877:1067390680": { quietMode: true },
      },
    },
  };

  const result = migration.rewriteSettingsChatKeys(settings, {
    discord: "1519908956212822117",
    onebot: "2301401877",
  });

  assert.deepEqual(result.rewritten, {
    "discord:1519918607071576239":
      "discord/1519908956212822117:1519918607071576239",
  });
  assert.deepEqual(Object.keys(result.settings.chat.byChatKey).sort(), [
    "discord/1519908956212822117:1519918607071576239",
    "onebot/2301401877:1067390680",
  ]);
  assert.deepEqual(
    result.settings.chat.byChatKey[
      "discord/1519908956212822117:1519918607071576239"
    ],
    { turnPolicy: "record_only" },
  );
});
