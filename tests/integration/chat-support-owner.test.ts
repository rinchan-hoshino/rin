import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const support = await importBuiltModule<
  typeof import("../../src/core/chat/support.js")
>("dist/core/chat/support.js");

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-support-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("chat support owns canonical chat keys, access checks, and bot lookup", () => {
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "42" }),
    "private",
  );
  assert.equal(
    support.inferChatType({ platform: "telegram", chatId: "-42" }),
    "group",
  );
  assert.equal(
    support.isPrivateChat({ platform: "onebot", chatId: "private:7" }),
    true,
  );
  assert.equal(
    support.composeChatKey(" telegram ", " -42 ", " bot "),
    "telegram/bot:-42",
  );
  assert.equal(support.composeChatKey("telegram", "-42"), "");
  assert.deepEqual(support.parseChatKey(" telegram/bot:-42 "), {
    platform: "telegram",
    botId: "bot",
    chatId: "-42",
  });
  for (const invalid of ["", "telegram:-42", "telegram/:42", "telegram/bot:"]) {
    assert.equal(support.parseChatKey(invalid), null);
    assert.equal(support.normalizeChatKey(invalid), undefined);
  }
  assert.equal(
    support.normalizeChatKey(" telegram/bot:-42 "),
    "telegram/bot:-42",
  );
  assert.throws(
    () => support.chatStateDir("/tmp/data", "legacy:42"),
    /invalid_chatKey/,
  );
  assert.equal(
    support.chatStatePath("/tmp/data", "discord/bot:channel"),
    path.join(
      "/tmp/data",
      "chat",
      "session-state",
      "discord",
      "bot",
      "channel",
      "state.json",
    ),
  );

  for (const trust of ["OWNER", "TRUSTED"]) {
    assert.equal(
      support.canAccessAgentInput({ chatType: "private", trust }),
      true,
    );
    assert.equal(
      support.canAccessAgentInput({
        chatType: "group",
        trust,
        mentionLike: true,
      }),
      true,
    );
    assert.equal(support.canRunCommand(trust, "/new"), true);
  }
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: "OWNER",
      allowWithoutMention: true,
    }),
    true,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: "OWNER",
      commandLike: true,
    }),
    false,
  );
  assert.equal(
    support.canAccessAgentInput({ chatType: "private", trust: "OTHER" }),
    false,
  );
  assert.equal(support.canRunCommand("OWNER", "  "), false);
  assert.equal(support.canRunCommand("OTHER", "new"), false);

  const app = {
    bots: [
      { platform: " telegram ", selfId: " bot ", label: "tg" },
      { platform: "discord", selfId: "one", label: "dc" },
    ],
  };
  assert.deepEqual(
    support.botsForPlatform(app, " telegram ").map((bot: any) => bot.label),
    ["tg"],
  );
  assert.deepEqual(support.botsForPlatform({ bots: null }, "telegram"), []);
  assert.deepEqual(support.botsForPlatform(app, ""), []);
  assert.equal(support.findBot(app, "telegram", "bot")?.label, "tg");
  assert.equal(support.findBot(app, "telegram", "missing"), null);
  assert.equal(support.findBot(app, "missing", "bot"), null);
  assert.equal(
    support.composeChatKeyForBot(app, "discord", "channel", "one"),
    "discord/one:channel",
  );
});

test("chat support discovers controller state and preserves identity ownership invariants", async () => {
  await withTempDir(async (dataDir) => {
    const stateRoot = path.join(dataDir, "chat", "session-state");
    await fs.mkdir(path.join(stateRoot, "telegram", "bot", "chat"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stateRoot, "telegram", "bot", "chat", "state.json"),
      "{}\n",
    );
    await fs.mkdir(path.join(stateRoot, "legacy", "direct"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(stateRoot, "legacy", "direct", "state.json"),
      "{}\n",
    );
    assert.deepEqual(support.listChatStateFiles(stateRoot), [
      {
        chatKey: "telegram/bot:chat",
        statePath: path.join(
          stateRoot,
          "telegram",
          "bot",
          "chat",
          "state.json",
        ),
      },
    ]);
    assert.deepEqual(
      support.listChatStateFiles(path.join(dataDir, "missing")),
      [],
    );

    const cronRoot = path.join(dataDir, "cron-turns");
    await fs.mkdir(path.join(cronRoot, "b"), { recursive: true });
    await fs.mkdir(path.join(cronRoot, "a"), { recursive: true });
    await fs.writeFile(
      path.join(cronRoot, "a", "state.json"),
      JSON.stringify({ chatKey: "telegram/bot:a" }),
    );
    await fs.writeFile(path.join(cronRoot, "b", "state.json"), "{broken");
    assert.deepEqual(support.listDetachedControllerStateFiles(cronRoot), [
      {
        controllerKey: "a",
        statePath: path.join(cronRoot, "a", "state.json"),
        chatKey: "telegram/bot:a",
      },
      {
        controllerKey: "b",
        statePath: path.join(cronRoot, "b", "state.json"),
        chatKey: "cron:b",
      },
    ]);
    assert.deepEqual(
      support.listDetachedControllerStateFiles(path.join(dataDir, "absent")),
      [],
    );

    support.ensureIdentitySeed(dataDir);
    support.ensureIdentitySeed(dataDir);
    assert.deepEqual(support.loadIdentity(dataDir), {
      persons: {},
      aliases: [],
      trusted: [],
    });
    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir,
          actorPlatform: "telegram",
          actorUserId: "u1",
          trust: "TRUSTED",
        }),
      /identity_owner_bootstrap_required/,
    );
    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir,
          actorPlatform: "telegram",
          actorUserId: "u1",
          targetUserId: "u2",
          trust: "OWNER",
        }),
      /identity_first_owner_must_self_claim/,
    );
    const owner = support.updateIdentityTrust({
      dataDir,
      actorPlatform: "telegram",
      actorUserId: "u1",
      actorName: "Owner",
      trust: "OWNER",
    });
    assert.equal(owner.bootstrap, true);
    assert.equal(owner.name, "Owner");
    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir,
          actorPlatform: "telegram",
          actorUserId: "u2",
          actorTrust: "TRUSTED",
          trust: "TRUSTED",
        }),
      /identity_owner_required/,
    );
    support.updateIdentityTrust({
      dataDir,
      actorPlatform: "telegram",
      actorUserId: "u1",
      actorTrust: "OWNER",
      targetUserId: "u2",
      targetName: "Friend",
      trust: "TRUSTED",
    });
    support.updateIdentityTrust({
      dataDir,
      actorPlatform: "telegram",
      actorUserId: "u1",
      actorTrust: "OWNER",
      targetUserId: "u3",
      trust: "OWNER",
    });
    support.updateIdentityTrust({
      dataDir,
      actorPlatform: "telegram",
      actorUserId: "u1",
      actorTrust: "OWNER",
      targetUserId: "u1",
      trust: "OTHER",
    });
    const identity = support.loadIdentity(dataDir);
    assert.equal(support.countOwnerIdentities(identity), 1);
    assert.equal(support.hasOwnerIdentity(identity), true);
    assert.equal(support.trustOf(identity, "telegram", "u1"), "OTHER");
    assert.equal(support.trustOf(identity, "telegram", "u2"), "TRUSTED");
    assert.equal(support.trustOf(identity, "telegram", "u3"), "OWNER");
    assert.equal(support.trustOf(identity, "", "u3"), "OTHER");
    assert.equal(support.trustOf(identity, "telegram", "missing"), "OTHER");
    assert.throws(
      () =>
        support.updateIdentityTrust({
          dataDir,
          actorPlatform: "telegram",
          actorUserId: "u3",
          actorTrust: "OWNER",
          targetUserId: "u3",
          trust: "OTHER",
        }),
      /identity_last_owner_required/,
    );
    assert.throws(
      () =>
        support.setIdentityTrust({
          dataDir,
          platform: "",
          userId: "u4",
          trust: "OTHER",
        }),
      /identity_platform_required/,
    );
    assert.throws(
      () =>
        support.setIdentityTrust({
          dataDir,
          platform: "telegram",
          userId: "",
          trust: "OTHER",
        }),
      /identity_user_id_required/,
    );
  });
});
