import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const prompt = await importBuiltModule<
  typeof import("../../src/core/self-improve/prompt.js")
>("dist/core/self-improve/prompt.js");

test("self-improve review prompt contains the complete agent-facing guidance", () => {
  const agentDir = path.join(path.sep, "tmp", "rin-agent");
  const rendered = prompt.buildSelfImproveReviewPrompt(agentDir);
  assert.match(rendered, /Review this conversation/);
  assert.match(rendered, new RegExp(path.join(agentDir, "self_improve")));
  assert.match(rendered, /## Choose the right place/);
  assert.match(rendered, /## Make the change/);
  assert.match(rendered, /`memory-index`.*provenance, chronology/);
  assert.match(rendered, /`short-term-memory`.*temporary continuity/);
  assert.match(rendered, /read `rin-prompt-engineering`/);
  assert.match(rendered, /read `skill-creator`/);
  assert.doesNotMatch(
    rendered,
    /self-improve-distillation\.md|trigger|turn.window|leaf|routing/i,
  );
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 2_000);
});

test("self-improve review prompt supports the documented default agent path", () => {
  const rendered = prompt.buildSelfImproveReviewPrompt();
  assert.match(rendered, /<agentDir>\/self_improve/);
  assert.doesNotMatch(rendered, /docs\/rin\/docs/);
});
