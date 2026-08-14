import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const { runPiNativeCompactionWithoutFileSummary } = await importBuiltModule<
  typeof import("../../src/core/pi/session-host.js")
>("dist/core/pi/session-host.js");

test("split-turn compaction replaces an obsolete reporting cadence with the latest correction", async () => {
  const model = {
    id: "split-turn-model",
    name: "Split Turn Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const prompts: string[] = [];
  const session = {
    model,
    thinkingLevel: "medium",
    agent: {
      streamFunction: async (_model: any, context: any) => {
        prompts.push(context.messages[0].content[0].text);
        return {
          result: async () => ({
            role: "assistant",
            content: [
              {
                type: "text",
                text: [
                  "## Goal",
                  "Continue the audit.",
                  "## Constraints & Preferences",
                  "- Report every 500 companies; next report at 3,000.",
                ].join("\n"),
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "split-turn-model",
            usage,
            stopReason: "stop",
            timestamp: Date.now(),
          }),
        };
      },
    },
    modelRuntime: {
      async getAuth() {
        return { auth: { apiKey: "test" } };
      },
    },
    settingsManager: {
      getRetrySettings: () => undefined,
    },
    _summarizationRetryCallbacks: () => undefined,
  };
  const event = {
    reason: "threshold",
    preparation: {
      firstKeptEntryId: "keep-after-prefix",
      messagesToSummarize: [
        {
          role: "user",
          content: "Report after every 50 companies.",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Processed 1,550 companies." }],
          timestamp: 2,
        },
      ],
      turnPrefixMessages: [
        {
          role: "user",
          content: "Use batches of 500 instead.",
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Applied batches of 500. Reports at 2,000 and 2,500 were sent; next is 3,000.",
            },
          ],
          timestamp: 4,
        },
      ],
      isSplitTurn: true,
      tokensBefore: 243_552,
      fileOps: {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
      },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    },
  };

  const result = await runPiNativeCompactionWithoutFileSummary(session, event);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Report after every 50 companies/);
  assert.match(prompts[0], /Use batches of 500 instead/);
  assert.match(prompts[0], /reconstruct the task state at its end/i);
  assert.match(prompts[0], /supersede incompatible earlier state/i);
  assert.doesNotMatch(result.summary, /Turn Context \(split turn\)/);
  assert.match(result.summary, /Report every 500 companies/);
  assert.match(result.summary, /next report at 3,000/);
});
