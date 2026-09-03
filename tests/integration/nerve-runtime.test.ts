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

const expectedSystemPrompt = `This is a persistent agent session driven by event triggers.

Each user message is the exact payload emitted by a trigger. It reports something that occurred and is not necessarily a request. Decide what it means and whether or when to act. More events may arrive while a turn is active.

A normal assistant response in this session is not delivered externally. Use an appropriate tool to communicate or affect external state.

Trigger files live at ~/.rin/nerve/triggers/*.ts and export:

export async function start(ctx) {}

ctx provides triggerId, stateDir, signal, emit({ dedupeKey?, body }), sleepFor(), and sleepUntil(). After changing or deleting a trigger, run rin nerve reload <triggerId>.`;

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

test("nerve runtime submits every opaque input to one managed brain", async () => {
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
  });
  try {
    await runtime.start();
    const first = await runtime.emit({
      dedupeKey: "test:first",
      body: "one",
    });
    const second = await runtime.emit({
      dedupeKey: "test:second",
      body: "two",
    });
    await waitFor(() => submissions.length === 2);

    assert.equal(submissions[0].managedSessionLeaf, "nerve-main-v2");
    assert.equal(submissions[0].streamingBehavior, "steer");
    assert.deepEqual(submissions[0].disabledRinCapabilities, ["self_improve"]);
    assert.equal("noSkills" in submissions[0], false);
    assert.equal(submissions[0].appendSystemPrompt[0], expectedSystemPrompt);
    assert.equal(submissions[0].requestTag, `nerve:${first.stimulusId}`);
    assert.equal(submissions[0].text, "one");
    assert.equal("promptContext" in submissions[0], false);
    assert.equal(submissions[1].requestTag, `nerve:${second.stimulusId}`);
    assert.equal(submissions[1].text, "two");

    assert.deepEqual(runtime.status().queue, {
      queued: 0,
      inflight: 0,
      delivered: 2,
    });
    assert.equal("ownerChatKey" in runtime.status(), false);
  } finally {
    await runtime.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("later stimuli steer before the current turn finishes", async () => {
  const agentDir = await tempDir();
  const submissions: any[] = [];
  const completions: Array<() => void> = [];
  const runtime = nerve.createNerveRuntime({
    agentDir,
    startTriggers: false,
    triggerWorkerPath: process.execPath,
    driver: {
      async submitTurn(input: any) {
        submissions.push(input);
        return await new Promise((resolve) => {
          completions.push(() =>
            resolve({ outcome: "nonterminal", requestTag: input.requestTag }),
          );
        });
      },
      async abort() {},
      async disconnect() {},
      state() {
        return { turnActive: submissions.length > completions.length };
      },
    } as any,
  });

  try {
    await runtime.start();
    await runtime.emit({ body: "first" });
    await waitFor(() => submissions.length === 1);

    await runtime.emit({ body: "second" });
    await runtime.emit({ body: "third" });
    await waitFor(() => submissions.length === 3, 100);

    assert.deepEqual(
      submissions.map((input) => input.text),
      ["first", "second", "third"],
    );
    assert.deepEqual(runtime.status().queue, {
      queued: 0,
      inflight: 3,
      delivered: 0,
    });

    for (const complete of completions) complete();
    await waitFor(() => runtime.status().queue.delivered === 3);
  } finally {
    for (const complete of completions) complete();
    await runtime.stop();
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
