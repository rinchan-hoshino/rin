import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const types = await importBuiltModule<Record<string, unknown>>(
  "dist/core/self-improve/core/types.js",
);

test("self-improve runtime constants keep prompt limits and state filenames explicit", () => {
  assert.deepEqual(types.SELF_IMPROVE_PROMPT_SLOTS, [
    "agent_profile",
    "user_profile",
    "core_doctrine",
  ]);
  assert.deepEqual(types.SELF_IMPROVE_PROMPT_LIMITS, {
    agent_profile: { maxLines: 8, fidelity: ["exact", "fuzzy"] },
    user_profile: { maxLines: 4, fidelity: ["exact", "fuzzy"] },
    core_doctrine: { maxLines: 32, fidelity: ["fuzzy", "exact"] },
  });
  assert.equal(types.CHRONICLE_TAG, "chronicle");
  assert.equal(types.EPISODE_TAG, "episode");
  assert.equal(types.PROCESS_STATE_FILE, "process-state.json");
  assert.equal(types.RELATIONS_STATE_FILE, "relations.json");
});
