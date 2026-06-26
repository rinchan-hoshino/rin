import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);

test("chat support infers chat types from normalized targets", () => {
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "123456" }),
    "private",
  );
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "-100123" }),
    "group",
  );
  assert.equal(
    support.inferChatType({ platform: "onebot", chatId: "private:42" }),
    "private",
  );
  assert.equal(
    support.inferChatType({ platform: "onebot", chatId: "1067390680" }),
    "group",
  );
  assert.equal(
    support.inferChatType({ platform: "discord", chatId: "channel-1" }),
    "group",
  );
});

test("chat support parses shared chat targets for private detection", () => {
  const parsed = support.parseChatKey("onebot/2301401877:private:519418441");
  assert.deepEqual(parsed, {
    platform: "onebot",
    botId: "2301401877",
    chatId: "private:519418441",
  });
  assert.equal(support.isPrivateChat(parsed), true);
});

test("chat support keeps compose, parse, and normalize symmetric across bot requirements", () => {
  assert.equal(
    support.composeChatKey("discord", " channel-1 "),
    "discord:channel-1",
  );
  assert.equal(
    support.composeChatKey("discord", " channel-1 ", " bot-1 "),
    "discord/bot-1:channel-1",
  );
  assert.equal(
    support.composeChatKey(" telegram ", " -100123 ", " 8623230033 "),
    "telegram/8623230033:-100123",
  );
  assert.equal(
    support.composeChatKey("telegram", "-100123"),
    "telegram:-100123",
  );
  assert.deepEqual(support.parseChatKey(" discord:channel-1 "), {
    platform: "discord",
    botId: "",
    chatId: "channel-1",
  });
  assert.deepEqual(support.parseChatKey(" discord/bot-1:channel-1 "), {
    platform: "discord",
    botId: "bot-1",
    chatId: "channel-1",
  });
  assert.deepEqual(support.parseChatKey(" telegram:-100123 "), {
    platform: "telegram",
    botId: "",
    chatId: "-100123",
  });
  assert.equal(support.normalizeChatKey(" discord/:channel-1 "), undefined);
  assert.equal(
    support.normalizeChatKey(" discord:channel-1 "),
    "discord:channel-1",
  );
  assert.equal(
    support.normalizeChatKey(" discord/bot-1:channel-1 "),
    "discord/bot-1:channel-1",
  );
  assert.equal(
    support.normalizeChatKey(" telegram/8623230033:-100123 "),
    "telegram/8623230033:-100123",
  );
});

test("updateIdentityTrust bootstraps the first owner as a self-claim", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-support-"));
  try {
    const result = support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "u1",
      trust: "OWNER",
      actorName: "Alice",
    });

    assert.equal(result.trust, "OWNER");
    assert.equal(result.bootstrap, true);
    const identity = support.loadIdentity(dir);
    assert.equal(support.hasOwnerIdentity(identity), true);
    assert.equal(support.trustOf(identity, "telegram", "u1"), "OWNER");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("updateIdentityTrust lets an owner grant trusted and owner roles", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-support-"));
  try {
    support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "owner-1",
      trust: "OWNER",
    });
    const trusted = support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "owner-1",
      actorTrust: "OWNER",
      targetPlatform: "telegram",
      targetUserId: "trusted-1",
      trust: "TRUSTED",
      targetName: "Bob",
    });
    const owner2 = support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "owner-1",
      actorTrust: "OWNER",
      targetPlatform: "telegram",
      targetUserId: "owner-2",
      trust: "OWNER",
      targetName: "Carol",
    });

    assert.equal(trusted.trust, "TRUSTED");
    assert.equal(owner2.trust, "OWNER");
    const identity = support.loadIdentity(dir);
    assert.equal(support.trustOf(identity, "telegram", "trusted-1"), "TRUSTED");
    assert.equal(support.trustOf(identity, "telegram", "owner-2"), "OWNER");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("updateIdentityTrust rejects non-owner role changes after bootstrap", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-support-"));
  try {
    support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "owner-1",
      trust: "OWNER",
    });

    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir: dir,
          actorPlatform: "telegram",
          actorUserId: "trusted-1",
          actorTrust: "TRUSTED",
          targetPlatform: "telegram",
          targetUserId: "trusted-2",
          trust: "TRUSTED",
        }),
      /identity_owner_required/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("updateIdentityTrust refuses to remove the last remaining owner", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-support-"));
  try {
    support.updateIdentityTrust({
      dataDir: dir,
      actorPlatform: "telegram",
      actorUserId: "owner-1",
      trust: "OWNER",
    });

    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir: dir,
          actorPlatform: "telegram",
          actorUserId: "owner-1",
          actorTrust: "OWNER",
          targetPlatform: "telegram",
          targetUserId: "owner-1",
          trust: "OTHER",
        }),
      /identity_last_owner_required/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("chat support normalizes trust lookup and bot selection over dirty metadata", () => {
  assert.equal(
    support.trustOf(
      {
        aliases: [
          { platform: " telegram ", userId: " 42 ", personId: " owner " },
          { platform: "telegram", userId: "99", personId: "missing" },
        ],
        persons: {
          owner: { trust: " owner " },
        },
      },
      "telegram",
      "42",
    ),
    "OWNER",
  );
  assert.equal(
    support.trustOf(
      {
        aliases: [{ platform: "telegram", userId: "99", personId: "missing" }],
        persons: {},
      },
      "telegram",
      "99",
    ),
    "OTHER",
  );

  const app = {
    bots: [
      { platform: " telegram ", selfId: " 8623230033 ", name: "tg" },
      { platform: "discord", selfId: "1", name: "dc" },
      { platform: "discord", selfId: "2", name: "dc2" },
    ],
  };
  assert.equal(support.findBot(app, "telegram", "8623230033")?.name, "tg");
  assert.equal(support.findBot(app, "telegram")?.name, "tg");
  assert.equal(support.findBot(app, "discord")?.name, "dc");
  assert.equal(support.findBot(app, "discord", "2")?.name, "dc2");
  assert.equal(support.findBot(app, "onebot", "1"), null);
  assert.equal(
    support.composeChatKeyForBot(app, "discord", "channel-1", "1"),
    "discord:channel-1",
  );
  assert.equal(
    support.composeChatKeyForBot(app, "discord", "channel-1", "2"),
    "discord/2:channel-1",
  );
  assert.equal(
    support.composeChatKeyForBot(app, "telegram", "-100123", "8623230033"),
    "telegram:-100123",
  );
});
