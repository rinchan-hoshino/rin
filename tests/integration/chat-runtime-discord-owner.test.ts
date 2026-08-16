import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  app,
  logger,
  owner,
  resetOwner,
  withTempDir,
} from "../support/chat-runtime-adapters-owner-harness.ts";

const adapters = Object.assign(
  {},
  await import(
    pathToFileURL(path.resolve("dist/core/chat-runtime/discord.js")).href
  ),
);

test("discord adapter owns SDK lifecycle, native wrappers, indicators, and ingress", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const log = logger();
    const targetApp = app();
    const missing = new adapters.DiscordAdapter(targetApp, directory, {}, log);
    await assert.rejects(missing.start(), /discord_token_required/);
    assert.deepEqual(
      (missing as any)
        .mergeDiscordRecoveryMessages(
          [{ id: "beta" }, { id: "10" }, { id: "" }],
          [{ id: "alpha" }, { id: "2" }, { id: "10", newest: true }],
        )
        .map((message: any) => message.id),
      ["2", "10", "alpha", "beta"],
    );

    const messages = new Map<string, any>();
    const channel = {
      id: "channel-1",
      name: "owner-chat",
      guild: {
        id: "guild-1",
        name: "Owner Guild",
        members: {
          fetch: async (id: string) => ({ id, user: { id, bot: false } }),
        },
      },
      sendTyping: async () => "typed",
      permissionsFor: () => ({ has: () => false }),
      send: async (payload: any) => {
        const message = {
          id: `sent-${messages.size + 1}`,
          payload,
          edit: async (next: any) => ({ id: "edited", ...next }),
          react: async (emoji: string) => `reacted:${emoji}`,
          reactions: {
            cache: {
              find: () => ({ users: { remove: async (id: string) => id } }),
            },
          },
        };
        messages.set(message.id, message);
        return message;
      },
      messages: {
        fetch: async (id: string) => messages.get(id),
        delete: async (id: string) => messages.delete(id),
      },
    };
    owner.discordChannelById["channel-1"] = channel;
    owner.discordGuildById["guild-1"] = channel.guild;

    const adapter = new adapters.DiscordAdapter(
      targetApp,
      directory,
      { token: "discord-token" },
      log,
    );
    await adapter.start();
    const bot = adapter.bot;
    assert.equal(bot.status, 1);
    assert.equal(bot.selfId, "discord-bot");
    assert.equal(bot.user.name, "Rin Bot");
    assert.deepEqual(owner.discordClients[0].options.intents, [1, 2, 4, 8]);
    assert.deepEqual(owner.discordClients[0].options.partials, ["channel"]);
    assert.equal(owner.discordClients[0].options.rest.timeout, 60_000);
    assert.equal(owner.discordClients[0].options.rest.retries, 1);
    assert.equal(
      typeof owner.discordClients[0].options.rest.makeRequest,
      "function",
    );
    assert.equal(await bot.internal.fetchChannel("channel-1"), channel);
    assert.equal(await bot.internal.fetchGuild("guild-1"), channel.guild);
    assert.equal(
      (await bot.internal.fetchGuildMember("guild-1", "owner")).id,
      "owner",
    );
    assert.equal(await bot.internal.sendTyping("channel-1"), "typed");
    assert.equal(await bot.getGuildMember("channel-1", "owner"), null);
    channel.permissionsFor = () => ({ has: (flag: any) => flag === 1024n });
    assert.equal((await bot.getGuildMember("channel-1", "owner")).id, "owner");

    const typing = bot.workingIndicators.find(
      (item: any) => item.presentation === "typing",
    );
    const reaction = bot.workingIndicators.find(
      (item: any) => item.presentation === "reaction",
    );
    assert.equal(await typing.tick({}), false);
    assert.equal(await typing.tick({ chatId: "channel-1" }), true);
    const source = await channel.send({ content: "source" });
    assert.equal(
      await reaction.tick({
        chatId: "channel-1",
        messageId: source.id,
        reactionTick: 0,
      }),
      true,
    );
    assert.equal(
      await reaction.tick({
        chatId: "channel-1",
        messageId: source.id,
        reactionTick: 1,
      }),
      false,
    );
    assert.equal(await reaction.end({ chatId: "channel-1" }), true);
    assert.equal(await reaction.end({}), false);

    owner.discordClients[0].emit("message", {
      id: "incoming-1",
      createdTimestamp: 123,
      channelId: "channel-1",
      guildId: "guild-1",
      channel,
      guild: channel.guild,
      author: { id: "owner", username: "owner", bot: false },
      member: { displayName: "Owner" },
      mentions: { users: { has: () => true } },
      attachments: new Map([
        ["image", { url: "https://owner/image.png", name: "image.png" }],
        [
          "file",
          {
            proxyURL: "https://owner/file.txt",
            name: "file.txt",
            contentType: "text/plain",
          },
        ],
      ]),
      content: "<@discord-bot>, hello",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const inbound = targetApp.records.find(([name]) => name === "message")?.[1];
    assert.equal(inbound.stripped.content, "hello");
    assert.deepEqual(
      inbound.elements.map((node: any) => node.type),
      ["text", "image", "file"],
    );

    for (const interaction of [
      null,
      { isChatInputCommand: () => false },
      {
        isChatInputCommand: () => true,
        user: { id: "discord-bot" },
      },
      { isChatInputCommand: () => true, user: { id: "bot", bot: true } },
    ]) {
      await (adapter as any).handleInteraction(interaction);
    }

    await adapter.stop();
    assert.equal(bot.status, 0);
    owner.discordDestroyError = new Error("destroy owner");
    await adapter.stop();
  });
});

test("discord adapter reports failed catch-up without hiding client cleanup", async () => {
  resetOwner();
  await withTempDir(async (directory) => {
    const targetApp = app();
    const adapter = new adapters.DiscordAdapter(
      targetApp,
      directory,
      { token: "discord-token" },
      logger(),
    );
    (adapter as any).recoverDiscordMessages = async () => {
      throw new Error("owner catch-up failed");
    };
    owner.discordDestroyError = new Error("destroy also failed");
    await assert.rejects(adapter.start(), /owner catch-up failed/);
    assert.deepEqual(adapter.bot.inboundRecovery, {
      status: "degraded",
      failures: ["owner catch-up failed"],
    });
  });
});
