import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const decision = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "decision.js")).href
);

const identity = {
  aliases: [
    { platform: "example", userId: "owner-1", personId: "owner" },
    { platform: "example", userId: "trusted-1", personId: "trusted" },
  ],
  persons: {
    owner: { trust: "OWNER" },
    trusted: { trust: "TRUSTED" },
  },
};

function session(overrides: Record<string, any> = {}) {
  const value = {
    platform: "example",
    selfId: "agent-1",
    userId: "owner-1",
    channelId: "direct-1",
    isDirect: true,
    bot: { selfId: "agent-1" },
    stripped: { content: "hello" },
    elements: [{ type: "text", attrs: { content: "hello" } }],
    ...overrides,
  };
  if (overrides.guildId && overrides.isDirect === undefined) {
    value.isDirect = false;
  }
  return value;
}

async function allowed(value: any) {
  return (
    await decision.shouldProcessText(value, value.elements || [], identity)
  ).allow;
}

test("chat decision keeps slash-containing owner text routable", async () => {
  assert.equal(
    await allowed(session({ stripped: { content: "/usage hello" } })),
    true,
  );
});

test("chat decision rejects trusted private messages without an owner", async () => {
  assert.equal(await allowed(session({ userId: "trusted-1" })), false);
});

test("chat decision consumes private-like membership proof from the platform leaf", async () => {
  const base = session({
    guildId: "group-1",
    channelId: "group-1",
    bot: {
      selfId: "agent-1",
      async getCompleteMemberProof() {
        return { complete: true, nonAgentUserIds: ["owner-1"] };
      },
    },
  });
  assert.equal(await allowed(base), true);

  base.bot.getCompleteMemberProof = async () => ({
    complete: true,
    privateLike: false,
  });
  assert.equal(await allowed(base), false);
});

test("chat decision rejects incomplete and failed platform membership proofs", async () => {
  for (const getCompleteMemberProof of [
    undefined,
    async () => ({ complete: false }),
    async () => ({ complete: true, nonAgentUserIds: [""] }),
    async () => {
      throw new Error("proof failed");
    },
  ]) {
    assert.equal(
      await decision.isPrivateLikeGroupSession(
        session({
          guildId: `group-${Math.random()}`,
          channelId: `group-${Math.random()}`,
          bot: { selfId: "agent-1", getCompleteMemberProof },
        }),
        identity,
      ),
      false,
    );
  }

  const trusted = session({
    userId: "trusted-1",
    guildId: "group-membership-failure",
    channelId: "group-membership-failure",
    bot: {
      selfId: "agent-1",
      async isChatMember() {
        throw new Error("membership failed");
      },
    },
  });
  assert.equal(await decision.isOwnerPresentForChat(trusted, identity), false);
  assert.equal(
    await decision.isOwnerPresentForChat(
      { ...trusted, bot: { selfId: "agent-1" } },
      identity,
    ),
    false,
  );
  assert.deepEqual(
    await decision.resolveChatInputAccess(
      session({ userId: "unknown" }),
      identity,
    ),
    { allow: false, trust: "OTHER", ownerPresent: false },
  );
});

test("chat decision requires platform-owned owner membership for trusted group mentions", async () => {
  let ownerPresent = true;
  const grouped = session({
    userId: "trusted-1",
    guildId: "group-1",
    channelId: "group-1",
    stripped: { content: "hello", appel: true },
    elements: [
      { type: "at", attrs: { id: "agent-1" } },
      { type: "text", attrs: { content: "hello" } },
    ],
    bot: {
      selfId: "agent-1",
      async getCompleteMemberProof() {
        return { complete: true, privateLike: false };
      },
      async isChatMember(_chatId: string, userId: string) {
        return ownerPresent && userId === "owner-1";
      },
    },
  });
  assert.equal(await allowed(grouped), true);
  ownerPresent = false;
  assert.equal(await allowed(grouped), false);
});

test("chat decision keeps image-only owner messages routable", async () => {
  assert.equal(
    await allowed(
      session({
        stripped: { content: "" },
        elements: [{ type: "image", attrs: { src: "file:///tmp/image.png" } }],
      }),
    ),
    true,
  );
});

test("chat decision ignores owner group messages that only mention other users", async () => {
  assert.equal(
    await allowed(
      session({
        guildId: "group-1",
        channelId: "group-1",
        stripped: { content: "hello" },
        elements: [{ type: "at", attrs: { id: "someone-else" } }],
        bot: {
          selfId: "agent-1",
          async getCompleteMemberProof() {
            return { complete: true, privateLike: false };
          },
        },
      }),
    ),
    false,
  );
});
