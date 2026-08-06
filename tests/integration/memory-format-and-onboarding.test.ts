import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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
        self_improve_prompt_slot: "core_doctrine",
        content: "Verified",
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
  assert.match(text, /Core doctrine:\nVerified/);
  assert.equal(text.includes("Project rules:\nSpecific"), false);
  assert.ok(!text.includes("ignored"));
  assert.ok(!text.includes("# Self-Improve Prompts"));
  assert.equal(
    format.buildSystemPromptSelfImprove({ self_improve_prompt_docs: [] }),
    "",
  );
});

test("self-improve system prompt prefers full docs over preview docs", () => {
  const text = format.buildSystemPromptSelfImprove({
    self_improve_prompt_prompt_docs: [
      {
        self_improve_prompt_slot: "agent_profile",
        content: "FULL AGENT PROFILE",
      },
      {
        self_improve_prompt_slot: "user_profile",
        content: "FULL USER PROFILE",
      },
      {
        self_improve_prompt_slot: "core_doctrine",
        content: "FULL CORE DOCTRINE",
      },
    ],
    self_improve_prompt_docs: [
      {
        self_improve_prompt_slot: "agent_profile",
        preview: "PREVIEW AGENT PROFILE",
      },
      {
        self_improve_prompt_slot: "user_profile",
        preview: "PREVIEW USER PROFILE",
      },
      {
        self_improve_prompt_slot: "core_doctrine",
        preview: "PREVIEW CORE DOCTRINE",
      },
    ],
  });

  assert.equal((text.match(/Agent profile:/g) || []).length, 1);
  assert.equal((text.match(/User profile:/g) || []).length, 1);
  assert.equal((text.match(/Core doctrine:/g) || []).length, 1);
  assert.match(
    text,
    /Use this agent profile as the standing role, voice, and response-style contract\./,
  );
  assert.match(
    text,
    /Follow this core doctrine as the standing methodology and decision contract\./,
  );
  assert.equal(text.includes("Always use this agent profile"), false);
  assert.equal(text.includes("Always follow this core doctrine"), false);
  assert.match(text, /FULL AGENT PROFILE/);
  assert.match(text, /FULL USER PROFILE/);
  assert.match(text, /FULL CORE DOCTRINE/);
  assert.equal(text.includes("PREVIEW AGENT PROFILE"), false);
  assert.equal(text.includes("PREVIEW USER PROFILE"), false);
  assert.equal(text.includes("PREVIEW CORE DOCTRINE"), false);
});

test("self-improve format renders stable result variants", () => {
  const response = {
    query: " profile ",
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
    self_improve_prompt_prompt_docs: [{ path: "/tmp/agent.md" }],
  };
  const emptyResponse = {
    query: " profile ",
    results: [],
  };

  const listText = format.formatSelfImproveResult("list", response);
  assert.match(listText, /Self-improve prompts \(1\):/);
  assert.match(listText, /tags=core,prompt/);

  const searchText = format.formatSelfImproveResult("search", response);
  assert.match(searchText, /Self-improve matches for: profile/);
  assert.match(searchText, /score=0.88/);

  const saveText = format.formatSelfImproveResult(
    "save_self_improve_prompt",
    response,
  );
  assert.match(saveText, /Saved self-improve prompt: Agent Profile/);
  assert.equal(saveText.includes("/tmp/agent.md"), false);

  const compileText = format.formatSelfImproveResult("compile", {
    self_improve_prompt_prompt_docs: [
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
  assert.match(agentSearchText, /^self_improve search profile \(1\)$/m);
  assert.match(agentSearchText, /score=0.88/);

  const agentCompileText = format.formatSelfImproveAgentResult(
    "compile",
    response,
  );
  assert.match(agentCompileText, /^self_improve compile profile$/m);
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
    "No self-improve matches for: profile",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("list", emptyResponse),
    "self_improve list 0",
  );
  assert.equal(
    format.formatSelfImproveAgentResult("search", emptyResponse),
    "self_improve search profile (0)",
  );

  assert.equal(
    format.formatSelfImproveAgentResult("", {}),
    "self_improve result",
  );
});

test("memory onboarding helper preserves manual provenance and runtime path", () => {
  const prompt = onboarding.buildOnboardingPrompt("manual", "/tmp/rin-agent");
  assert.match(prompt, /The user explicitly requested Rin initialization/);
  assert.match(prompt, /\/tmp\/rin-agent\/docs\/rin\/docs\/initialization\.md/);
  assert.match(prompt, /as the initialization contract/);
  assert.doesNotMatch(prompt, /~\/\.rin/);
  assert.doesNotMatch(prompt, /hidden initialization instructions/);
  assert.doesNotMatch(prompt, /capabilities\.md/);
  assert.doesNotMatch(prompt, /one question/);
});
