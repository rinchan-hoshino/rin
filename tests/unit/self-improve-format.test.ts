import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const format = await importBuiltModule<
  typeof import("../../src/core/self-improve/format.js")
>("dist/core/self-improve/format.js");

const rows = [
  {
    id: "agent-profile",
    name: "Agent Profile",
    exposure: "always",
    scope: "global",
    kind: "instruction",
    self_improve_prompt_slot: "agent_profile",
    tags: ["core", " prompt ", ""],
    path: "/tmp/agent.md",
    description: "Keep replies concise.",
    score: 0.875,
  },
  {
    id: "fallback-id",
    exposure: "",
    scope: "",
    kind: "",
    tags: null,
    description: "",
    score: 0,
  },
  {},
];

test("self-improve format compiles labelled prompt documents", () => {
  const result = {
    self_improve_prompt_prompt_docs: [
      {
        self_improve_prompt_slot: "agent_profile",
        content: "Concise",
        preview: "ignored preview",
      },
      {
        id: "core-doctrine",
        self_improve_prompt_slot: "core_doctrine",
        preview: "Verified",
      },
      { name: "user-profile", content: "Known owner" },
      { id: "missing-body" },
      { content: "missing label" },
      null,
    ],
  };

  assert.equal(
    format.buildCompiledSelfImprovePrompt(result),
    [
      "Agent profile:",
      "Concise",
      "",
      "Core doctrine:",
      "Verified",
      "",
      "User profile:",
      "Known owner",
    ].join("\n"),
  );
  const system = format.buildSystemPromptSelfImprove(result);
  assert.equal(
    system,
    [
      "Agent profile:",
      "Standing role, voice, and response contract.",
      "Concise",
      "",
      "Core doctrine:",
      "Standing method and decision contract.",
      "Verified",
      "",
      "User profile:",
      "Known owner",
    ].join("\n"),
  );
  assert.equal(format.buildCompiledSelfImprovePrompt(null), "");
});

test("self-improve format renders human list and search results", () => {
  const response = { query: " profile ", results: rows };
  const list = format.formatSelfImproveResult("list", response);
  assert.match(list, /Self-improve prompts \(3\):/);
  assert.match(
    list,
    /- Agent Profile \[always\] scope=global kind=instruction slot=agent_profile tags=core,prompt path=\/tmp\/agent.md/,
  );
  assert.match(list, /- fallback-id/);
  assert.match(list, /- \(untitled\)/);

  const search = format.formatSelfImproveResult("search", response);
  assert.match(search, /Self-improve matches for: profile/);
  assert.match(search, /1\. Agent Profile — score=0.88 • always • global/);
  assert.match(search, /\/tmp\/agent.md\nKeep replies concise\./);
  assert.match(search, /2\. fallback-id — score=0.00/);

  assert.equal(
    format.formatSelfImproveResult("list", { results: [] }),
    "No self-improve prompts found.",
  );
  assert.equal(
    format.formatSelfImproveResult("search", { query: "none", results: [] }),
    "No self-improve matches for: none",
  );
});

test("self-improve format renders compact agent results", () => {
  const response = {
    query: " profile ",
    results: rows,
    self_improve_prompt_prompt_docs: [
      { path: "/tmp/agent.md" },
      { path: "" },
      null,
    ],
  };
  const list = format.formatSelfImproveAgentResult("list", response);
  assert.match(list, /^self_improve list 3/m);
  assert.match(
    list,
    /1\. Agent Profile \| always \| global \| instruction \| slot=agent_profile \| path=\/tmp\/agent.md/,
  );
  assert.match(list, /2\. fallback-id/);
  assert.match(list, /3\. \(untitled\)/);

  const search = format.formatSelfImproveAgentResult("search", response);
  assert.match(search, /^self_improve search profile \(3\)$/m);
  assert.match(
    search,
    /score=0.88 \| always \| global \| path=\/tmp\/agent.md/,
  );

  const compile = format.formatSelfImproveAgentResult("compile", response);
  assert.equal(
    compile,
    [
      "self_improve compile profile",
      "self_improve_prompts: 1",
      "self_improve_prompts[1] path=/tmp/agent.md",
    ].join("\n"),
  );
  assert.equal(
    format.formatSelfImproveAgentResult("compile", {}),
    "self_improve compile (no query)\nself_improve_prompts: 0",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("list", { results: [] }),
    "self_improve list 0",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("search", {
      query: "none",
      results: [],
    }),
    "self_improve search none (0)",
  );
});

test("self-improve format renders save, compile, and fallback actions", () => {
  assert.equal(
    format.formatSelfImproveResult("save_self_improve_prompt", {
      doc: { id: "saved" },
    }),
    "Saved self-improve prompt: saved",
  );
  assert.equal(
    format.formatSelfImproveResult("save_self_improve_prompt", {}),
    "Saved self-improve prompt: (untitled)",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("save_self_improve_prompt", {}),
    "self_improve save_self_improve_prompt",
  );
  assert.equal(
    format.formatSelfImproveResult("compile", {}),
    "No compiled self-improve prompt available.",
  );
  assert.equal(
    format.formatSelfImproveResult("custom", {}),
    "Self-improve action completed: custom",
  );
  assert.equal(
    format.formatSelfImproveResult("", {}),
    "Self-improve action completed: unknown",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("custom", {}),
    "self_improve custom",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("", {}),
    "self_improve result",
  );
});
