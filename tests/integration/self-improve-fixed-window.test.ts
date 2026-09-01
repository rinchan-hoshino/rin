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
const selfImproveIndex = await import(
  pathToFileURL(path.join(rootDir, "dist/core/self-improve/index.js")).href
);

function userFrontend() {
  return { kind: "chat", key: "discord/1:2" };
}

function assistantFinal(label: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text: label }],
    stopReason: "stop",
    responseId: `response-${label}`,
  };
}

function linearTurnBranch(turns: number) {
  const entries: any[] = [];
  let parentId: string | null = null;
  for (let turn = 1; turn <= turns; turn += 1) {
    for (const message of [
      { role: "user", content: `turn ${turn}` },
      assistantFinal(`done ${turn}`),
    ]) {
      const id = `entry-${entries.length}`;
      entries.push({ id, parentId, type: "message", message });
      parentId = id;
    }
  }
  return entries;
}

async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function runClosingTurn(windowTurns: number | undefined, turns: number) {
  const queued: any[] = [];
  const branch = linearTurnBranch(turns);
  const closing = branch.at(-1).message;
  const definition = selfImproveIndex.default({
    ...(windowTurns === undefined
      ? {}
      : { selfImproveTurnWindowTurns: windowTurns }),
    async enqueueSelfImproveMaintenanceJob(job: any) {
      queued.push(job);
    },
  });
  const hook = definition.hooks.message_end?.[0];
  assert.equal(typeof hook, "function");
  await hook(
    { type: "message_end", message: closing },
    {
      agentDir: "/tmp/rin-agent",
      frontend: userFrontend(),
      promptContext: { source: "chat-bridge" },
      sessionManager: {
        getSessionFile: () => path.join(rootDir, "package.json"),
        getLeafId: () => branch.at(-1).id,
        getBranch: () => branch,
        isPersisted: () => true,
      },
    },
  );
  await settle();
  return queued;
}

test("self-improve defaults to one independent review every eight completed user turns", async () => {
  assert.equal((await runClosingTurn(undefined, 7)).length, 0);
  const queued = await runClosingTurn(undefined, 8);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].trigger, "self_improve:turn_window_review");
  assert.equal(queued[0].leafId, "entry-15");
  assert.equal(queued[0].sourceContext, undefined);
});

test("self-improve turn-window cadence is independently configurable", async () => {
  assert.equal((await runClosingTurn(2, 1)).length, 0);
  const queued = await runClosingTurn(2, 2);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].leafId, "entry-3");
});
