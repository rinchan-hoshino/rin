import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const format = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "self-improve", "format.js"))
    .href
);
const onboarding = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "onboarding.js"),
  ).href
);

test("self-improve format builds compact compiled prompt", () => {
  const text = format.buildCompiledSelfImprovePrompt({
    self_improve_prompt_prompt_docs: [
      {
        name: "Agent Profile",
        self_improve_prompt_slot: "agent_profile",
        path: "/tmp/agent_profile.md",
        content: "Concise",
      },
      {
        self_improve_prompt_slot: "core_facts",
        preview: "Verified",
      },
      {
        self_improve_prompt_slot: " ",
        content: "ignored",
      },
    ],
    self_improve_prompt_docs: [
      {
        id: "project_rules",
        content: "Specific",
      },
      null,
    ],
  });
  assert.match(text, /Agent profile:\nConcise/);
  assert.match(text, /Core facts:\nVerified/);
  assert.match(text, /Project rules:\nSpecific/);
  assert.ok(!text.includes("ignored"));
  assert.ok(!text.includes("# Self-Improve Prompts"));
  assert.equal(
    format.buildSystemPromptSelfImprove({ self_improve_prompt_docs: [] }),
    "",
  );
});

test("self-improve format renders stable result variants", () => {
  const response = {
    query: " memory ",
    results: [
      {
        id: "agent-profile",
        name: "Agent Profile",
        exposure: "always",
        scope: "global",
        kind: "instruction",
        self_improve_prompt_slot: "agent_profile",
        tags: ["core", " prompt "],
        path: "/tmp/agent.md",
        description: "Keep replies concise.",
        score: 0.875,
      },
    ],
    doc: {
      name: "Agent Profile",
      path: "/tmp/agent.md",
    },
    self_improve_prompt_docs: [{ path: "/tmp/agent.md" }],
  };
  const emptyResponse = {
    query: " memory ",
    results: [],
  };

  const listText = format.formatSelfImproveResult("list", response);
  assert.match(listText, /Self-improve prompts \(1\):/);
  assert.match(listText, /tags=core,prompt/);

  const searchText = format.formatSelfImproveResult("search", response);
  assert.match(searchText, /Self-improve matches for: memory/);
  assert.match(searchText, /score=0.88/);

  const saveText = format.formatSelfImproveResult(
    "save_self_improve_prompt",
    response,
  );
  assert.match(saveText, /Saved self-improve prompt: Agent Profile/);
  assert.equal(saveText.includes("/tmp/agent.md"), false);

  const compileText = format.formatSelfImproveResult("compile", {
    self_improve_prompt_docs: [
      { self_improve_prompt_slot: "agent_profile", content: "Concise" },
    ],
  });
  assert.match(compileText, /Agent profile:\nConcise/);

  assert.equal(
    format.formatSelfImproveResult("unknown", {}),
    "Self-improve action completed: unknown",
  );

  const agentListText = format.formatSelfImproveAgentResult("list", response);
  assert.match(agentListText, /^self_improve list 1/m);
  assert.match(
    agentListText,
    /1\. Agent Profile \| always \| global \| instruction \| slot=agent_profile \| path=\/tmp\/agent.md/,
  );

  const agentSearchText = format.formatSelfImproveAgentResult(
    "search",
    response,
  );
  assert.match(agentSearchText, /^self_improve search memory \(1\)$/m);
  assert.match(agentSearchText, /score=0.88/);

  const agentCompileText = format.formatSelfImproveAgentResult(
    "compile",
    response,
  );
  assert.match(agentCompileText, /^self_improve compile memory$/m);
  assert.match(agentCompileText, /self_improve_prompts: 1/);

  assert.equal(
    format.formatSelfImproveAgentResult("save_self_improve_prompt", response),
    "self_improve save_self_improve_prompt",
  );

  assert.equal(
    format.formatSelfImproveResult("list", emptyResponse),
    "No self-improve prompts found.",
  );
  assert.equal(
    format.formatSelfImproveResult("search", emptyResponse),
    "No self-improve matches for: memory",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("list", emptyResponse),
    "self_improve list 0",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("search", emptyResponse),
    "self_improve search memory (0)",
  );

  assert.equal(
    format.formatSelfImproveAgentResult("", {}),
    "self_improve result",
  );
});

test("memory onboarding helper keeps hidden instructions and pending state", () => {
  const prompt = onboarding.buildOnboardingPrompt("manual");
  assert.ok(prompt.includes("Do not mention, quote, summarize"));
  assert.ok(prompt.includes("preferred language"));
  assert.ok(prompt.includes("you are still learning"));
  assert.ok(prompt.includes("trust the process"));
});
