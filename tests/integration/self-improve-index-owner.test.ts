import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const selfImprove = await importBuiltModule<
  typeof import("../../src/core/self-improve/index.js")
>("dist/core/self-improve/index.js");

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-self-index-owner-"),
  );
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function assistantFinal(text = "done") {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolCall() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "checking" },
      { type: "toolCall", name: "read", arguments: {} },
    ],
  };
}

function context(
  root: string,
  sessionFile: string,
  id: string,
  overrides: Record<string, any> = {},
) {
  return {
    agentDir: root,
    frontend: { kind: "chat", key: "telegram/bot:owner" },
    promptContext: { source: "chat-bridge", selfImproveEligible: true },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => sessionFile,
      getLeafId: () => "leaf",
      isPersisted: () => true,
    },
    ...overrides,
  };
}

async function createSession(root: string, name: string, content = "") {
  const file = path.join(root, "sessions", `${name}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

test("self-improve index reads the bounded periodic-review setting", async () => {
  await withTempRoot(async (root) => {
    assert.equal(selfImprove.readSelfImproveReviewEveryTurns(""), 5);
    assert.equal(selfImprove.readSelfImproveReviewEveryTurns(root), 5);
    for (const [value, expected] of [
      [3, 3],
      [3.9, 3],
      [0, 5],
      [-1, 5],
      ["bad", 5],
    ] as const) {
      await fs.writeFile(
        path.join(root, "settings.json"),
        JSON.stringify({ selfImprove: { reviewEveryTurns: value } }),
      );
      assert.equal(selfImprove.readSelfImproveReviewEveryTurns(root), expected);
    }
    await fs.writeFile(path.join(root, "settings.json"), "{bad");
    assert.equal(selfImprove.readSelfImproveReviewEveryTurns(root), 5);
  });
});

test("self-improve index counts only persisted assistant finals and checkpoints each interval", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ selfImprove: { reviewEveryTurns: 2 } }),
    );
    const sessionFile = await createSession(root, "periodic");
    const calls: any[] = [];
    const definition = selfImprove.default({
      async runSelfImproveMaintenanceJobNow(job: any) {
        calls.push(job);
        return { status: "completed" };
      },
    } as any);
    assert.equal(definition.name, "self_improve");
    assert.deepEqual(definition.tools, []);
    assert.equal(definition.hooks?.tool_execution_start?.length, 1);
    const messageEnd = definition.hooks!.message_end![0]!;
    const ctx = context(root, sessionFile, "periodic-owner");

    await messageEnd({ message: { role: "user" } }, ctx as any);
    await messageEnd({ message: assistantToolCall() }, ctx as any);
    assert.equal(calls.length, 0);
    await messageEnd({ message: assistantFinal("one") }, ctx as any);
    await messageEnd({ message: assistantFinal("two") }, ctx as any);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].snapshotKey, "review:2");
    assert.equal(calls[0].trigger, "self_improve:periodic_review");
    await messageEnd({ message: assistantFinal("three") }, ctx as any);
    assert.equal(calls.length, 1);
    await messageEnd({ message: assistantFinal("four") }, ctx as any);
    assert.equal(calls[1].snapshotKey, "review:4");
  });
});

test("self-improve index resumes branch-local final counts and contains runner failures", async () => {
  await withTempRoot(async (root) => {
    const rows = [
      {
        type: "message",
        id: "one",
        parentId: null,
        message: assistantFinal("one"),
      },
      {
        type: "message",
        id: "tool",
        parentId: "one",
        message: assistantToolCall(),
      },
      {
        type: "message",
        id: "two",
        parentId: "tool",
        message: assistantFinal("two"),
      },
      {
        type: "message",
        id: "other",
        parentId: "one",
        message: assistantFinal("other branch"),
      },
    ];
    const sessionFile = await createSession(
      root,
      "persisted",
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ selfImprove: { reviewEveryTurns: 2 } }),
    );
    const definition = selfImprove.default({
      async runSelfImproveMaintenanceJobNow() {
        throw new Error("review failed");
      },
    } as any);
    const ctx = context(root, sessionFile, "persisted-owner", {
      sessionManager: {
        getSessionId: () => "persisted-owner",
        getSessionFile: () => sessionFile,
        getLeafId: () => "two",
        isPersisted: () => true,
      },
    });
    await assert.doesNotReject(() =>
      definition.hooks!.message_end![0]!(
        { message: assistantFinal("two") },
        ctx as any,
      ),
    );

    await fs.writeFile(sessionFile, "{bad\n");
    const fallbackCalls: any[] = [];
    const fallback = selfImprove.default({
      async runSelfImproveMaintenanceJobNow(job: any) {
        fallbackCalls.push(job);
      },
    } as any);
    const fallbackCtx = context(root, sessionFile, "bad-json-owner");
    await fallback.hooks!.message_end![0]!(
      { message: assistantFinal("one") },
      fallbackCtx as any,
    );
    await fallback.hooks!.message_end![0]!(
      { message: assistantFinal("two") },
      fallbackCtx as any,
    );
    assert.equal(fallbackCalls.length, 1);
  });
});

test("self-improve index accepts only explicit eligible frontend producers", async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(
      path.join(root, "settings.json"),
      JSON.stringify({ selfImprove: { reviewEveryTurns: 1 } }),
    );
    const sessionFile = await createSession(root, "eligibility");
    const calls: any[] = [];
    const definition = selfImprove.default({
      async runSelfImproveMaintenanceJobNow(job: any) {
        calls.push(job);
      },
    } as any);
    const messageEnd = definition.hooks!.message_end![0]!;
    const cases: Array<[string, any, boolean]> = [
      [
        "chat-no-key",
        context(root, sessionFile, "chat-no-key", {
          frontend: { kind: "chat" },
        }),
        false,
      ],
      [
        "gui",
        context(root, sessionFile, "gui", {
          frontend: { kind: "gui" },
          promptContext: undefined,
        }),
        true,
      ],
      [
        "tui-manager",
        context(root, sessionFile, "tui-manager", {
          frontend: undefined,
          promptContext: undefined,
          sessionManager: {
            __rinFrontend: { kind: "tui", id: "main" },
            getSessionId: () => "tui-manager",
            getSessionFile: () => sessionFile,
            getLeafId: () => "leaf",
            isPersisted: () => true,
          },
        }),
        true,
      ],
      [
        "background",
        context(root, sessionFile, "background", {
          frontend: undefined,
          promptContext: undefined,
        }),
        false,
      ],
      [
        "scheduled-event",
        context(root, sessionFile, "scheduled-event", {
          frontend: undefined,
          promptContext: undefined,
        }),
        true,
      ],
      [
        "unknown-eligible",
        context(root, sessionFile, "unknown-eligible", {
          frontend: { kind: "custom", key: "x" },
        }),
        false,
      ],
    ];
    for (const [name, ctx, expected] of cases) {
      const before = calls.length;
      const event: any = { message: assistantFinal(name) };
      if (name === "scheduled-event") {
        event.promptContext = {
          taskContextKind: "scheduled-task",
          selfImproveEligible: true,
        };
        event.source = "scheduled-task";
      }
      await messageEnd(event, ctx);
      assert.equal(calls.length > before, expected, name);
    }
  });
});

test("self-improve index skips ephemeral state, reloads, missing files, and incomplete metadata", async () => {
  await withTempRoot(async (root) => {
    const sessionFile = await createSession(root, "shutdown");
    const definition = selfImprove.default({} as any);
    const messageEnd = definition.hooks!.message_end![0]!;
    const shutdown = definition.hooks!.session_shutdown![0]!;

    await messageEnd(
      { message: assistantFinal() },
      context(root, sessionFile, "not-persisted", {
        sessionManager: {
          getSessionId: () => "not-persisted",
          getSessionFile: () => sessionFile,
          getLeafId: () => "leaf",
          isPersisted: () => false,
        },
      }) as any,
    );
    await messageEnd(
      { message: assistantFinal() },
      context(root, "", "missing-file") as any,
    );
    await shutdown(
      { reason: "reload" },
      context(root, sessionFile, "reload") as any,
    );
    await shutdown(
      {},
      context(root, sessionFile, "background-shutdown", {
        frontend: undefined,
        promptContext: undefined,
      }) as any,
    );
    await shutdown(
      {},
      context(root, sessionFile, "ephemeral-shutdown", {
        sessionManager: {
          getSessionId: () => "ephemeral-shutdown",
          getSessionFile: () => sessionFile,
          getLeafId: () => "leaf",
          isPersisted: () => false,
        },
      }) as any,
    );
    assert.equal(definition.tools?.length, 0);
  });
});
