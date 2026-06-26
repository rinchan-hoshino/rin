import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const extraAdapters = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", "extra-adapters.js"),
  ).href
);

function namedPermission(value: boolean, name: string, bit: bigint) {
  return {
    has(flag: unknown) {
      return value && (flag === name || flag === bit);
    },
  };
}

function viewPermission(value: boolean) {
  return namedPermission(value, "ViewChannel", 1024n);
}

function adminPermission(value: boolean) {
  return namedPermission(value, "Administrator", 8n);
}

test("discord adapter proves owner-only channels from private permission overwrites", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-discord-"),
  );
  try {
    let bot: any = null;
    const adapter = new extraAdapters.DiscordAdapter(
      {
        register(_adapter: unknown, registeredBot: any) {
          bot = registeredBot;
        },
      },
      agentDir,
      {},
      { warn() {}, info() {}, error() {}, debug() {} },
    );
    assert.ok(bot);
    bot.selfId = "bot-discord";

    let guildOwnerId = "owner-discord";
    const roles = new Map<string, any>([
      ["guild-1", { id: "guild-1", permissions: adminPermission(false) }],
    ]);
    const overwrites = new Map<string, any>([
      [
        "guild-1",
        {
          id: "guild-1",
          type: 0,
          allow: viewPermission(false),
          deny: viewPermission(true),
        },
      ],
      [
        "owner-discord",
        {
          id: "owner-discord",
          type: 1,
          allow: viewPermission(true),
          deny: viewPermission(false),
        },
      ],
      [
        "bot-discord",
        {
          id: "bot-discord",
          type: 1,
          allow: viewPermission(true),
          deny: viewPermission(false),
        },
      ],
    ]);
    (adapter as any).client = {
      channels: {
        async fetch(channelId: string) {
          assert.equal(channelId, "channel-owner-only");
          return {
            guild: {
              id: "guild-1",
              ownerId: guildOwnerId,
              roles: { everyone: { id: "guild-1" }, cache: roles },
              members: {
                async fetch(userId: string) {
                  return {
                    id: userId,
                    user: { bot: userId === "bot-discord" },
                  };
                },
              },
            },
            permissionOverwrites: { cache: overwrites },
          };
        },
      },
    };

    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      true,
    );

    overwrites.set("other-user", {
      id: "other-user",
      type: 1,
      allow: viewPermission(true),
      deny: viewPermission(false),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );

    overwrites.delete("other-user");
    overwrites.set("other-bot", {
      id: "other-bot",
      type: 1,
      allow: viewPermission(true),
      deny: viewPermission(false),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );

    overwrites.delete("other-bot");
    guildOwnerId = "server-owner";
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );

    guildOwnerId = "owner-discord";
    roles.set("admin-role", {
      id: "admin-role",
      managed: false,
      permissions: adminPermission(true),
    });
    assert.equal(
      await bot.hasOnlyOwnerUsers("channel-owner-only", ["owner-discord"]),
      false,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
