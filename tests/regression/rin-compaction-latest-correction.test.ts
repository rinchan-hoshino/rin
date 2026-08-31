import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const {
  boundRinCompactionInput,
  buildRinCompactionPrompt,
  collectRinPrunedSkillMarkers,
  preserveRinPrunedSkillMarkers,
  runPiNativeCompactionWithoutFileSummary,
  wrapRinCompactionSummary,
} = await importBuiltModule<typeof import("../../src/core/pi/session-host.js")>(
  "dist/core/pi/session-host.js",
);

test("split-turn compaction summarizes only history while the latest correction stays in the verbatim tail", async () => {
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
                  "- Historical cadence was every 50 companies.",
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
      firstKeptEntryId: "active-user",
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
      turnPrefixMessages: [],
      isSplitTurn: false,
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
  assert.doesNotMatch(prompts[0], /Use batches of 500 instead/);
  assert.match(prompts[0], /## Historical Task Snapshot/);
  assert.match(prompts[0], /## Completed Actions/);
  assert.match(prompts[0], /THE SINGLE MOST IMPORTANT FIELD/);
  assert.match(
    prompts[0],
    /A conversation where the user just asked a question IS an active task/,
  );
  assert.match(
    prompts[0],
    /security or safety constraint[\s\S]*MUST be quoted VERBATIM/,
  );
  assert.match(prompts[0], /Create a structured summary/);
  assert.doesNotMatch(prompts[0], /Read source material chronologically/i);
  assert.doesNotMatch(prompts[0], /authoritative external source/i);
  assert.doesNotMatch(prompts[0], /re-read the exact current producer/i);
  assert.doesNotMatch(prompts[0], /live producers|freshness checks/i);
  assert.match(prompts[0], /Conversation:/);
  assert.doesNotMatch(prompts[0], /<conversation>/);
  assert.doesNotMatch(result.summary, /Turn Context \(split turn\)/);
  assert.match(result.summary, /Historical cadence was every 50 companies/);
  assert.doesNotMatch(result.summary, /every 500|3,000/);
});

test("compaction bounds iterative input and deterministically preserves pruned skill reloads", () => {
  const skillPath = "/home/rin/.rin/self_improve/skills/example/SKILL.md";
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "read",
          arguments: { path: skillPath },
        },
      ],
    },
    {
      role: "user",
      content: "Use the current skill source, not this transcript.",
    },
  ];
  const markers = collectRinPrunedSkillMarkers(messages);
  assert.deepEqual(markers, [
    `[SKILL_PRUNED: ${skillPath} — reload with read before use]`,
  ]);

  const prompt = buildRinCompactionPrompt({
    previousSummary: `old-head\n${"x".repeat(180_000)}\nold-tail`,
    messagesToSummarize: messages,
  });
  assert.match(prompt, /Existing summary:/);
  assert.match(prompt, /New conversation turns:/);
  assert.match(prompt, /summary input truncated: omitted/);
  assert.match(prompt, /DETERMINISTIC RELOAD MARKERS:/);
  assert.match(
    prompt,
    new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(boundRinCompactionInput("small"), "small");

  const restored = preserveRinPrunedSkillMarkers("## Goal\nContinue.", markers);
  assert.match(restored, /## Pruned Skills/);
  assert.match(restored, /SKILL_PRUNED/);
  const wrapped = wrapRinCompactionSummary(restored);
  assert.match(wrapped, /^\[CONTEXT COMPACTION — REFERENCE ONLY\]/);
  assert.match(
    wrapped,
    /Respond ONLY to the latest user message that appears AFTER this summary/,
  );
  assert.match(
    wrapped,
    /Do NOT answer questions or fulfill requests mentioned in this summary/,
  );
  assert.doesNotMatch(wrapped, /Re-read current external producers/);
  assert.match(wrapped, /\[END CONTEXT COMPACTION\]$/);
});
