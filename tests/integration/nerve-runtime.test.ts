import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const nerve = await importBuiltModule<
  typeof import("../../src/core/nerve/runtime.js")
>("dist/core/nerve/runtime.js");
const nerveConfig = await importBuiltModule<
  typeof import("../../src/core/nerve/config.js")
>("dist/core/nerve/config.js");

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "rin-nerve-runtime-"));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("wait_for_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("nerve runtime submits every stimulus to one managed brain with steer semantics", async () => {
  const agentDir = await tempDir();
  const submissions: any[] = [];
  const driver = {
    async submitTurn(input: any) {
      submissions.push(input);
      return {
        outcome: submissions.length === 1 ? "terminalOwner" : "nonterminal",
        requestTag: input.requestTag,
        sessionFile: "/tmp/nerve-main.jsonl",
      };
    },
    async abort() {},
    async disconnect() {},
    state() {
      return { sessionFile: "/tmp/nerve-main.jsonl", turnActive: true };
    },
  };
  const runtime = nerve.createNerveRuntime({
    agentDir,
    driver: driver as any,
    startTriggers: false,
    triggerWorkerPath: process.execPath,
    ownerChatKey: "discord/1:9",
  });
  try {
    await runtime.start();
    await runtime.emit({
      id: "s1",
      producer: "test",
      sensation: "first",
      body: "one",
    });
    await runtime.emit({
      id: "s2",
      producer: "test",
      sensation: "second",
      body: "two",
    });
    await waitFor(() => submissions.length === 2);

    assert.equal(submissions[0].managedSessionLeaf, "nerve-main");
    assert.equal(submissions[0].streamingBehavior, "steer");
    assert.deepEqual(submissions[0].disabledRinCapabilities, ["self_improve"]);
    assert.equal("noSkills" in submissions[0], false);
    assert.match(
      submissions[0].appendSystemPrompt[0],
      /~\/\.rin\/nerve\/triggers/,
    );
    assert.equal(submissions[0].requestTag, "nerve:s1");
    assert.match(submissions[0].text, /first/);
    assert.equal(submissions[1].requestTag, "nerve:s2");

    assert.deepEqual(runtime.status().queue, {
      queued: 0,
      inflight: 0,
      delivered: 2,
    });
  } finally {
    await runtime.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("nerve config preserves one exact owner chatKey", async () => {
  const agentDir = await tempDir();
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ nerve: { ownerChatKey: "discord/bot:channel" } }),
  );
  assert.deepEqual(nerveConfig.loadNerveConfig(agentDir), {
    ownerChatKey: "discord/bot:channel",
  });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ nerve: { ownerChatKey: " discord/bot:channel" } }),
  );
  assert.throws(
    () => nerveConfig.loadNerveConfig(agentDir),
    /nerve_owner_chat_key_invalid/u,
  );
  await fs.rm(agentDir, { recursive: true, force: true });
});

test("owner chat hard reflex matches one exact chatKey and ignores every non-owner", async () => {
  const agentDir = await tempDir();
  const submissions: any[] = [];
  const runtime = nerve.createNerveRuntime({
    agentDir,
    startTriggers: false,
    triggerWorkerPath: process.execPath,
    ownerChatKey: "discord/1:9",
    driver: {
      async submitTurn(input: any) {
        submissions.push(input);
        return { outcome: "terminalOwner", requestTag: input.requestTag };
      },
      async abort() {},
      async disconnect() {},
      state() {
        return {};
      },
    } as any,
  });
  try {
    await runtime.start();
    assert.deepEqual(
      await runtime.observeChat({
        chatKey: "discord/1:8",
        messageId: "outside",
        trust: "OWNER",
        text: "outside",
        context: {},
      }),
      { handled: false, stimulated: false },
    );
    assert.deepEqual(
      await runtime.observeChat({
        chatKey: "discord/1:9",
        messageId: "other",
        trust: "OTHER",
        text: "other",
        context: {},
      }),
      { handled: true, stimulated: false },
    );
    assert.deepEqual(
      await runtime.observeChat({
        chatKey: "discord/1:9",
        messageId: "owner",
        trust: "OWNER",
        text: "owner text",
        context: { chatKey: "discord/1:9" },
      }),
      { handled: true, stimulated: true },
    );
    await waitFor(() => submissions.length === 1);
    assert.match(submissions[0].text, /owner text/);
  } finally {
    await runtime.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
