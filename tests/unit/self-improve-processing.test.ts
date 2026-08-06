import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const processing = await importBuiltModule<
  typeof import("../../src/core/self-improve/processing.js")
>("dist/core/self-improve/processing.js");

test("self-improve processing normalizes prompt list content", () => {
  assert.equal(processing.normalizePromptListContent(""), "");
  assert.equal(processing.countPromptLines(" \n "), 0);
  assert.equal(
    processing.normalizePromptListContent("  first\r\n- second\n\n  - third  "),
    "- first\n- second\n- third",
  );
  assert.equal(processing.countPromptLines("first\nsecond"), 2);
});

test("self-improve processing describes prompt slots with content and limits", () => {
  const state = processing.describeSelfImprovePromptSlot({
    slot: "agent_profile",
    existingContent: "Speak concise Chinese by default.",
  });
  assert.deepEqual(state, {
    slot: "agent_profile",
    name: "agent profile",
    content: "- Speak concise Chinese by default.",
    currentLines: 1,
    maxLines: 8,
  });
  assert.throws(
    () => processing.assertSelfImprovePromptSlot("unknown"),
    /self_improve_prompt_slot_required/,
  );
});

test("self-improve processing refines full-slot content and enforces limits", () => {
  const refined = processing.refineSelfImprovePromptSlot({
    slot: "user_profile",
    incomingContent:
      "Call the user Master by default.\nAvoid markdown in Chat bridge chats.",
  });
  assert.equal(
    refined.content,
    [
      "- Call the user Master by default.",
      "- Avoid markdown in Chat bridge chats.",
    ].join("\n"),
  );
  assert.equal(refined.nextLines, 2);
  assert.throws(
    () =>
      processing.refineSelfImprovePromptSlot({
        slot: "agent_profile",
        incomingContent: "  ",
      }),
    /self_improve_content_required/,
  );
  assert.throws(
    () =>
      processing.refineSelfImprovePromptSlot({
        slot: "agent_profile",
        incomingContent: Array.from(
          { length: 9 },
          (_, index) => `line ${index + 1}`,
        ).join("\n"),
      }),
    /self_improve_prompt_content_too_long:agent_profile:8/,
  );
});
