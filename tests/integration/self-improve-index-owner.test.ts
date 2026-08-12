import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importBuiltModule } from "../support/import-built-module.js";

const selfImprove = await importBuiltModule<
  typeof import("../../src/core/self-improve/index.js")
>("dist/core/self-improve/index.js");

function assistantFinal(label: string, overrides: Record<string, any> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: label }],
    stopReason: "stop",
    responseId: `response-${label}`,
    timestamp: `2026-08-07T00:00:0${label.length}.000Z`,
    ...overrides,
  };
}

function linearTurnBranch(turns: number) {
  const entries: any[] = [];
  let parentId: string | null = null;
  for (let turn = 1; turn <= turns; turn += 1) {
    for (const [role, message] of [
      ["user", { role: "user", content: `turn ${turn}` }],
      ["assistant", assistantFinal(`done-${turn}`)],
    ] as const) {
      const id = `owner-${role}-${turn}`;
      entries.push({ type: "message", id, parentId, message });
      parentId = id;
    }
  }
  return entries;
}

function context(
  branch: any[],
  overrides: Record<string, any> = {},
): Record<string, any> {
  const { sessionManager: managerOverrides = {}, ...contextOverrides } =
    overrides;
  return {
    agentDir: "/tmp/rin-self-improve-owner",
    frontend: { kind: "chat", key: "owner/chat" },
    promptContext: { selfImproveEligible: true },
    ...contextOverrides,
    sessionManager: {
      getSessionFile: () => fileURLToPath(import.meta.url),
      getLeafId: () => branch.at(-1)?.id,
      getBranch: () => branch,
      isPersisted: () => true,
      ...managerOverrides,
    },
  };
}

async function settleDeferredReview() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("self-improve message-end accepts only explicit current frontend producers", async () => {
  const branch = linearTurnBranch(4);
  const closing = branch.at(-1).message;
  const queued: any[] = [];
  const definition = selfImprove.default({
    selfImproveTurnWindowTurns: 4,
    async enqueueSelfImproveMaintenanceJob(job) {
      queued.push(job);
    },
  });
  const messageEnd = definition.hooks.message_end?.[0];
  assert.equal(typeof messageEnd, "function");
  assert.equal(definition.hooks.context, undefined);

  const cases: Array<[string, any, any, boolean]> = [
    [
      "event tui",
      { frontend: { kind: "TUI", id: "owner" } },
      context(branch),
      true,
    ],
    [
      "context tui",
      {},
      context(branch, {
        frontend: { kind: "tui", id: "owner" },
        promptContext: undefined,
      }),
      true,
    ],
    [
      "manager tui",
      {},
      context(branch, {
        frontend: undefined,
        promptContext: undefined,
        sessionManager: { __rinFrontend: { kind: "tui", key: "owner" } },
      }),
      true,
    ],
    [
      "chat without key",
      { frontend: { kind: "chat" } },
      context(branch),
      false,
    ],
    ["eligible chat", {}, context(branch), true],
    [
      "scheduled task kind",
      {
        promptContext: {
          taskContextKind: "scheduled-task",
          selfImproveEligible: true,
        },
      },
      context(branch, { frontend: undefined, promptContext: undefined }),
      true,
    ],
    [
      "scheduled prompt source",
      {
        promptContext: { source: "scheduled-task", selfImproveEligible: true },
      },
      context(branch, { frontend: undefined, promptContext: undefined }),
      true,
    ],
    [
      "scheduled event source",
      {
        source: "scheduled-task",
        promptContext: { selfImproveEligible: true },
      },
      context(branch, { frontend: { kind: "custom", key: "owner" } }),
      true,
    ],
    [
      "manager scheduled source",
      {},
      context(branch, {
        frontend: undefined,
        promptContext: undefined,
        sessionManager: {
          __rinLastPromptContext: { selfImproveEligible: true },
          __rinLastPromptSource: "scheduled-task",
        },
      }),
      true,
    ],
    [
      "custom frontend",
      {},
      context(branch, { frontend: { kind: "custom", key: "owner" } }),
      false,
    ],
    [
      "missing eligibility",
      {},
      context(branch, { frontend: undefined, promptContext: undefined }),
      false,
    ],
    [
      "scheduled without eligibility",
      { source: "scheduled-task" },
      context(branch, { frontend: undefined, promptContext: undefined }),
      false,
    ],
  ];

  for (const [name, eventOverrides, ctx, expected] of cases) {
    const before = queued.length;
    await messageEnd(
      { type: "message_end", message: closing, ...eventOverrides },
      ctx,
    );
    await settleDeferredReview();
    assert.equal(queued.length > before, expected, name);
  }

  assert.ok(queued.length > 0);
  assert.ok(
    queued.every(
      (job) =>
        job.trigger === "self_improve:turn_window_review" &&
        job.snapshotKey === "turn-window:4:4:owner-assistant-4" &&
        job.leafId === "owner-assistant-4",
    ),
  );
});

test("self-improve message-end fails closed at final, window, and persistence boundaries", async () => {
  const branch = linearTurnBranch(4);
  const closing = branch.at(-1).message;
  const queued: any[] = [];
  const definition = selfImprove.default({
    selfImproveTurnWindowTurns: 4,
    async enqueueSelfImproveMaintenanceJob(job) {
      queued.push(job);
    },
  });
  const messageEnd = definition.hooks.message_end[0];

  await messageEnd(
    { type: "message_end", message: { role: "user" } },
    context(branch),
  );
  await messageEnd(
    { type: "message_end", message: closing },
    context(branch, { sessionManager: { isPersisted: () => false } }),
  );
  await messageEnd(
    { type: "message_end", message: closing },
    context(branch, { sessionManager: { getSessionFile: () => "" } }),
  );
  await messageEnd(
    { type: "message_end", message: closing },
    context(branch, {
      sessionManager: { getSessionFile: () => "/missing/owner.jsonl" },
    }),
  );
  await messageEnd(
    { type: "message_end", message: closing },
    context(branch, { agentDir: "" }),
  );
  await messageEnd(
    { type: "message_end", message: linearTurnBranch(3).at(-1).message },
    context(linearTurnBranch(3)),
  );
  const missingLeaf = linearTurnBranch(4);
  missingLeaf.at(-1).id = "";
  await messageEnd(
    { type: "message_end", message: missingLeaf.at(-1).message },
    context(missingLeaf),
  );
  await messageEnd(
    { type: "message_end", message: assistantFinal("different") },
    context(branch),
  );
  await messageEnd(
    { type: "message_end", message: closing },
    context(branch, {
      sessionManager: {
        getBranch() {
          throw new Error("owner branch unavailable");
        },
      },
    }),
  );
  await settleDeferredReview();
  assert.deepEqual(queued, []);

  await messageEnd(
    {
      type: "message_end",
      message: { ...closing, content: "different", timestamp: "different" },
    },
    context(branch),
  );
  await settleDeferredReview();
  assert.equal(queued.length, 1, "matching response ids identify the final");

  const timestampBranch = linearTurnBranch(4);
  const timestampFinal = timestampBranch.at(-1).message;
  delete timestampFinal.responseId;
  await messageEnd(
    {
      type: "message_end",
      message: {
        ...timestampFinal,
        content: [{ type: "text", text: "done-4" }],
      },
    },
    context(timestampBranch),
  );
  await settleDeferredReview();
  assert.equal(
    queued.length,
    2,
    "timestamp, stop reason, and content can identify the final",
  );

  const throwing = selfImprove.default({
    async enqueueSelfImproveMaintenanceJob() {
      throw new Error("owner queue failure");
    },
  });
  await assert.doesNotReject(() =>
    throwing.hooks.message_end[0](
      { type: "message_end", message: closing },
      context(branch),
    ),
  );
  await settleDeferredReview();
});

test("self-improve shutdown uses complete windows or a persisted fallback review", async () => {
  const oneTurn = linearTurnBranch(1);
  const fourTurns = linearTurnBranch(4);
  const queued: any[] = [];
  const definition = selfImprove.default({
    selfImproveTurnWindowTurns: 4,
    async enqueueSelfImproveMaintenanceJob(job) {
      queued.push(job);
    },
  });
  const shutdown = definition.hooks.session_shutdown[0];

  await shutdown({ reason: " reload " }, context(oneTurn));
  await shutdown({}, context(oneTurn, { frontend: { kind: "custom" } }));
  await shutdown(
    {},
    context(oneTurn, { sessionManager: { isPersisted: () => false } }),
  );
  assert.deepEqual(queued, []);

  await shutdown(
    {},
    context([], { sessionManager: { getLeafId: () => undefined } }),
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].trigger, "self_improve:session_shutdown_review");
  assert.equal(queued[0].leafId, undefined);

  await shutdown(
    {},
    context(oneTurn, { sessionManager: { getLeafId: () => "fallback-leaf" } }),
  );
  assert.equal(queued.length, 2);
  assert.equal(queued[1].trigger, "self_improve:session_shutdown_review");
  assert.equal(queued[1].leafId, "fallback-leaf");

  await shutdown({}, context(fourTurns));
  assert.equal(queued.length, 3);
  assert.equal(queued[2].trigger, "self_improve:turn_window_review");
  assert.equal(queued[2].snapshotKey, "turn-window:4:4:owner-assistant-4");

  await shutdown(
    {},
    context(oneTurn, {
      sessionManager: { getSessionFile: () => "/missing/owner.jsonl" },
    }),
  );
  await shutdown({}, context(oneTurn, { agentDir: "" }));
  assert.equal(queued.length, 3);

  const throwing = selfImprove.default({
    async enqueueSelfImproveMaintenanceJob() {
      throw new Error("owner shutdown queue failure");
    },
  });
  await assert.doesNotReject(() =>
    throwing.hooks.session_shutdown[0]({}, context(fourTurns)),
  );
});
