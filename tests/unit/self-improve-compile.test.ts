import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type PromptDoc = Record<string, unknown>;
const compile = await importBuiltModule<{
  compileFromDocsAndEvents(
    docs: PromptDoc[],
    events: unknown[],
    graph: Record<string, unknown>,
    params?: Record<string, unknown>,
    root?: string,
  ): Record<string, unknown>;
}>("dist/core/self-improve/compile.js");

function doc(overrides: Record<string, unknown>): PromptDoc {
  return {
    name: "Doc",
    exposure: "self_improve_prompts",
    canonical: true,
    self_improve_prompt_slot: "core_doctrine",
    path: "/tmp/doc.md",
    content: " body ",
    ...overrides,
  };
}

test("self-improve compilation orders canonical prompt slots and trims context", () => {
  const result = compile.compileFromDocsAndEvents(
    [
      doc({
        name: "Core",
        self_improve_prompt_slot: "core_doctrine",
        content: " core ",
      }),
      doc({
        name: "Agent",
        self_improve_prompt_slot: "agent_profile",
        content: " agent ",
      }),
      doc({
        name: "Blank",
        self_improve_prompt_slot: "user_profile",
        content: " ",
      }),
      doc({ name: "Noncanonical", canonical: false }),
      doc({ name: "Skill", exposure: "self_improve_skills" }),
      doc({ name: "Unknown", self_improve_prompt_slot: "unknown" }),
    ],
    [],
    {},
    { query: " query ", domainQuery: " domain " },
    "/tmp/root",
  );
  assert.equal(result.root, "/tmp/root");
  assert.equal(result.query, "query");
  assert.equal(result.domain_query, "domain");
  assert.equal(
    result.self_improve_prompt_context,
    "[agent_profile] agent\n[core_doctrine] core",
  );
  assert.deepEqual(
    (
      result.self_improve_prompt_prompt_docs as Array<Record<string, unknown>>
    ).map((item) => item.name),
    ["Agent", "Blank", "Core"],
  );
  assert.deepEqual(result.self_improve_skills, []);
});

test("self-improve compilation uses empty defaults", () => {
  const result = compile.compileFromDocsAndEvents([], [], {});
  assert.equal(result.root, "");
  assert.equal(result.query, "");
  assert.equal(result.domain_query, "");
  assert.equal(result.self_improve_prompt_context, "");
  assert.deepEqual(result.self_improve_prompt_prompt_docs, []);
});
