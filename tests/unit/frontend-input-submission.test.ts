import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const submission = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/input-submission.js")
>("dist/core/rin-frontend-sdk/input-submission.js");

test("frontend input submission forwards normalized prompt metadata", async () => {
  const calls: any[] = [];
  const result = await submission.submitNativeFrontendPromptTurn(
    {
      async prompt(text, options) {
        calls.push({ text, options });
        return { accepted: true } as any;
      },
    },
    {
      text: "hello",
      images: [{ type: "image" }],
      source: "tui",
      requestTag: "tag-1",
      streamingBehavior: "steer",
      frontendIdentity: { kind: " tui ", key: " main " },
      promptContext: { source: "tui" },
      sessionFile: " /tmp/session.jsonl ",
      sessionId: " session-id ",
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [
    {
      text: "hello",
      options: {
        images: [{ type: "image" }],
        streamingBehavior: "steer",
        source: "tui",
        requestTag: "tag-1",
        frontendIdentity: { kind: "tui", key: "main" },
        promptContext: { source: "tui" },
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-id",
      },
    },
  ]);
});

test("frontend input submission omits blank optional metadata", async () => {
  const calls: any[] = [];
  await submission.submitNativeFrontendPromptTurn(
    {
      async prompt(text, options) {
        calls.push({ text, options });
      },
    },
    { text: "plain", sessionFile: " ", sessionId: " " },
  );
  assert.deepEqual(calls, [
    {
      text: "plain",
      options: {
        images: undefined,
        streamingBehavior: undefined,
        source: undefined,
        requestTag: undefined,
      },
    },
  ]);
});

test("frontend input submission waits for compaction and tolerates refresh failure", async () => {
  let compacting = true;
  let waiting = 0;
  let refreshes = 0;
  await submission.waitForFrontendInputSubmissionReady({
    isCompacting: () => compacting,
    onWaiting: () => {
      waiting += 1;
    },
    pollMs: 0,
    refresh: async () => {
      refreshes += 1;
      compacting = false;
      throw new Error("stale refresh");
    },
  });
  assert.equal(waiting, 1);
  assert.equal(refreshes, 1);
});

test("frontend input submission rejects abort and timeout gates", async () => {
  await assert.rejects(
    submission.waitForFrontendInputSubmissionReady({
      isAborted: () => true,
      abortErrorMessage: "cancelled",
    }),
    /cancelled/,
  );
  await assert.rejects(
    submission.waitForFrontendInputSubmissionReady({
      isCompacting: () => true,
      timeoutMs: -1,
      pollMs: 0,
    }),
    /frontend_compaction_timeout/,
  );
});
