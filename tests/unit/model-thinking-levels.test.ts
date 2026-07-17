import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const thinking = await importBuiltModule<{
  ALL_THINKING_LEVELS: readonly string[];
  computeAvailableThinkingLevels(model: {
    provider?: string | null;
    id?: string | null;
    reasoning?: boolean | null;
    thinkingLevelMap?: Record<string, string | null> | null;
  }): string[];
}>("dist/core/model-thinking-levels.js");

test("thinking levels keep non-reasoning and standard reasoning models bounded", () => {
  assert.deepEqual(thinking.computeAvailableThinkingLevels({}), ["off"]);
  assert.deepEqual(
    thinking.computeAvailableThinkingLevels({ reasoning: true }),
    ["off", "minimal", "low", "medium", "high"],
  );
});

test("Codex Max models receive all levels after normalized identity matching", () => {
  assert.deepEqual(
    thinking.computeAvailableThinkingLevels({
      provider: " OpenAI ",
      id: "GPT-CODEX-MAX-LATEST",
      reasoning: true,
    }),
    thinking.ALL_THINKING_LEVELS,
  );
  assert.equal(
    thinking
      .computeAvailableThinkingLevels({
        provider: "other",
        id: "codex-max",
        reasoning: true,
      })
      .includes("max"),
    false,
  );
});

test("thinking-level maps remove null levels and add explicitly mapped levels", () => {
  assert.deepEqual(
    thinking.computeAvailableThinkingLevels({
      provider: "openai",
      id: "codex-max",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        medium: null,
        xhigh: "xhigh",
        max: undefined as unknown as string,
      },
    }),
    ["minimal", "low", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    thinking.computeAvailableThinkingLevels({
      reasoning: true,
      thinkingLevelMap: null,
    }),
    ["off", "minimal", "low", "medium", "high"],
  );
});
