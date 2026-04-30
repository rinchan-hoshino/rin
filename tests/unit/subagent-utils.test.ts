import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const modelUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "model-utils.js"),
  ).href
);
const formatUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "format-utils.js"),
  ).href
);
const subagentIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "subagent", "index.js")).href
);
const subagentService = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "subagent", "service.js"))
    .href
);
const sessionUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "subagent", "session-utils.js"),
  ).href
);
const { SessionManager } = await import("@mariozechner/pi-coding-agent");

test("subagent model utils normalize and sort model refs", async () => {
  assert.equal(modelUtils.normalizeModelRef("@openai/gpt-5"), "openai/gpt-5");
  assert.equal(modelUtils.normalizeModelRef(" open ai/gpt-5 "), undefined);
  assert.deepEqual(modelUtils.splitModelRef("openai/gpt-5"), {
    provider: "openai",
    modelId: "gpt-5",
  });
  assert.equal(modelUtils.splitModelRef("open ai/gpt-5"), undefined);
  assert.ok(modelUtils.compareModelIds("gpt-5-20260301", "gpt-5-20250101") < 0);

  const summaries = await modelUtils.getProviderSummaries({
    modelRegistry: {
      getAvailable() {
        return [
          { provider: " openai ", id: " gpt-5-20250101 " },
          { provider: "openai", id: "gpt-5-20260301" },
          { provider: "openai", id: "gpt-5-20260301" },
          { provider: "anthropic", id: " claude-sonnet " },
          { provider: "", id: "ignored" },
          { provider: "openai", id: "bad model" },
        ];
      },
    },
  });
  assert.deepEqual(summaries, [
    {
      provider: "anthropic",
      count: 1,
      top3: ["claude-sonnet"],
      all: ["claude-sonnet"],
    },
    {
      provider: "openai",
      count: 2,
      top3: ["gpt-5-20260301", "gpt-5-20250101"],
      all: ["gpt-5-20260301", "gpt-5-20250101"],
    },
  ]);
  assert.deepEqual(Array.from(modelUtils.buildModelLookup(summaries)).sort(), [
    "anthropic/claude-sonnet",
    "openai/gpt-5-20250101",
    "openai/gpt-5-20260301",
  ]);
  assert.deepEqual(
    Array.from(
      modelUtils.buildModelLookup([
        {
          provider: " openai ",
          count: 3,
          top3: [" gpt-5 ", "gpt-5", "bad model"],
          all: [" gpt-5 ", "gpt-5", "bad model"],
        },
      ]),
    ),
    ["openai/gpt-5"],
  );
});

test("subagent format utils summarize results", () => {
  const persistedResult = {
    index: 1,
    prompt: "x",
    cwd: "/tmp",
    status: "done",
    exitCode: 0,
    output: "  hello world\r\n",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 3,
      turns: 1,
    },
    messages: [],
    sessionMode: "persist",
    sessionPersisted: true,
    sessionId: "abc123",
    sessionName: " auth-review ",
    sessionFile: " /tmp/auth-review.jsonl ",
  };

  const agentText = formatUtils.buildSubagentAgentText([persistedResult]);
  const userText = formatUtils.buildSubagentUserText([persistedResult]);
  const summary = formatUtils.summarizeTaskResult(persistedResult);

  assert.equal(
    agentText,
    "hello world\n\nSession: auth-review\nPath: /tmp/auth-review.jsonl",
  );
  assert.equal(userText, agentText);
  assert.match(
    summary,
    /\[done\] \(default model\) session=auth-review — hello world$/,
  );
  assert.ok(
    formatUtils
      .formatUsage({
        input: 1200,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      })
      .includes("↑1.2k"),
  );
  assert.equal(formatUtils.formatTokens(Number.NaN), "0");
  assert.equal(
    formatUtils.formatUsage(
      {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      "  openai/gpt-5  ",
    ),
    "openai/gpt-5",
  );
  assert.equal(
    formatUtils.getTaskSessionLabel({
      sessionPersisted: true,
      sessionName: "   ",
      sessionId: " session-123 ",
      sessionFile: " /tmp/demo.jsonl ",
    }),
    "session-123",
  );
  assert.equal(
    formatUtils.getTaskModelLabel({
      model: "   ",
      requestedModel: " openai/gpt-5 ",
    }),
    "openai/gpt-5",
  );
});

test("subagent format utils share persisted fallback labels and final output parsing", () => {
  const results = [
    {
      index: 1,
      prompt: "first",
      status: "done",
      exitCode: 0,
      output: "  first\nresult  ",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      messages: [],
      sessionMode: "persist",
      sessionPersisted: true,
    },
    {
      index: 2,
      prompt: "second",
      status: "error",
      exitCode: 1,
      errorMessage: "line one\nline two",
      output: "   ",
      model: " openai/gpt-5 ",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      messages: [],
      sessionMode: "memory",
      sessionPersisted: false,
    },
  ];

  const agentText = formatUtils.buildSubagentAgentText(results);
  const userText = formatUtils.buildSubagentUserText(results);

  assert.match(agentText, /1\. \(default model\) \[session: persisted\]/);
  assert.match(userText, /Parallel subagents finished: 1\/2 succeeded/);
  assert.match(
    userText,
    /1\. \[ok\] \(default model\) \[session: persisted\] — first result/,
  );
  assert.match(userText, /2\. \[failed\] openai\/gpt-5 — line one line two/);
  assert.equal(
    formatUtils.getTaskPreview(
      { output: "word ".repeat(60), errorMessage: "" },
      12,
    ),
    "word word wo…",
  );
  assert.equal(
    formatUtils.getTaskPrimaryText({
      output: "  \n  ",
      errorMessage: "\r\nfailed\r\n",
    }),
    "failed",
  );
  assert.equal(
    formatUtils.getTaskPrimaryText({ output: " ", errorMessage: " " }),
    "(no output)",
  );
  assert.equal(
    formatUtils.getFinalOutput([
      { role: "user", content: [{ type: "text", text: "ignore" }] },
      { role: "assistant", content: [{ type: "text", text: "  " }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]),
    "done",
  );
});

test("subagent task preferences are construction-time only", async () => {
  const prefs = await subagentIndex.applySubagentTaskPreferences({
    model: "openai/gpt-5",
    thinkingLevel: "xhigh",
  });

  assert.deepEqual(prefs, {
    modelRef: "openai/gpt-5",
    thinkingLevel: "xhigh",
  });
});

test("subagent defaults do not override resume or fork session model settings", () => {
  assert.equal(
    subagentService.shouldApplyCurrentSubagentDefaults({ mode: "memory" }),
    true,
  );
  assert.equal(
    subagentService.shouldApplyCurrentSubagentDefaults({ mode: "persist" }),
    true,
  );
  assert.equal(
    subagentService.shouldApplyCurrentSubagentDefaults({ mode: "resume" }),
    false,
  );
  assert.equal(
    subagentService.shouldApplyCurrentSubagentDefaults({ mode: "fork" }),
    false,
  );
});

test("subagent service can hide Rin capabilities from worker runtime", () => {
  const disabled = subagentService.resolveSubagentDisabledRinCapabilities([
    " memory ",
    "MEMORY",
    "",
    "SubAgent",
  ]);
  assert.deepEqual(disabled, ["memory", "subagent"]);
  assert.equal(disabled.includes("fetch"), false);
});

test("subagent service aggregates task state from current-run assistant messages", () => {
  const state = subagentService.collectTaskResultState([
    { role: "user", content: [{ type: "text", text: "ignore" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "first answer" }],
      provider: "openai",
      model: "gpt-5",
      stopReason: "tool_use",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 50,
        cost: { total: 0.1 },
      },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      provider: "openai",
      model: "gpt-5-mini",
      stopReason: "end_turn",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 60,
        cost: { total: 0.02 },
      },
    },
  ]);

  assert.equal(state.output, "final answer");
  assert.equal(state.stopReason, "end_turn");
  assert.equal(state.model, "openai/gpt-5-mini");
  assert.equal(state.usage.input, 11);
  assert.equal(state.usage.output, 22);
  assert.equal(state.usage.cacheRead, 33);
  assert.equal(state.usage.cacheWrite, 44);
  assert.equal(state.usage.contextTokens, 60);
  assert.equal(state.usage.turns, 2);
  assert.ok(Math.abs(state.usage.cost - 0.12) < 1e-9);
});

test("subagent service derives context tokens when providers omit explicit totals", () => {
  const state = subagentService.collectTaskResultState([
    {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provider: "openai",
      model: "gpt-5-mini",
      stopReason: "end_turn",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: { total: 0.1 },
      },
    },
  ]);

  assert.equal(state.usage.input, 10);
  assert.equal(state.usage.output, 20);
  assert.equal(state.usage.cacheRead, 30);
  assert.equal(state.usage.cacheWrite, 40);
  assert.equal(state.usage.contextTokens, 100);
  assert.equal(state.usage.turns, 1);
  assert.ok(Math.abs(state.usage.cost - 0.1) < 1e-9);
});

test("subagent session file helpers normalize agentDir-relative paths", () => {
  const agentDir = "/tmp/rin-agent";
  assert.equal(
    sessionUtils.resolveSubagentSessionFile(
      agentDir,
      " sessions/managed/subagent/demo.jsonl ",
    ),
    path.join(agentDir, "sessions", "managed", "subagent", "demo.jsonl"),
  );
  assert.equal(
    sessionUtils.resolveSubagentSessionFile(
      agentDir,
      " ./sessions//managed/subagent/nested/../demo.jsonl ",
    ),
    path.join(agentDir, "sessions", "managed", "subagent", "demo.jsonl"),
  );
  assert.equal(
    sessionUtils.resolveSubagentSessionFile(agentDir, "/tmp/demo.jsonl"),
    path.resolve("/tmp/demo.jsonl"),
  );
  assert.equal(
    sessionUtils.toSubagentSessionFile(
      agentDir,
      path.join(agentDir, "sessions", "managed", "subagent", "demo.jsonl"),
    ),
    "sessions/managed/subagent/demo.jsonl",
  );
  assert.equal(
    sessionUtils.toSubagentSessionFile(
      agentDir,
      " ./sessions//managed/subagent/nested/../demo.jsonl ",
    ),
    "sessions/managed/subagent/demo.jsonl",
  );
  assert.equal(
    sessionUtils.toSubagentSessionFile(agentDir, "/tmp/outside/demo.jsonl"),
    "/tmp/outside/demo.jsonl",
  );
});

test("subagent sessions default to managed namespace dir", () => {
  assert.equal(
    sessionUtils.getDefaultSubagentSessionDir(),
    path.join(os.homedir(), ".rin", "sessions", "managed", "subagent"),
  );
});

test("run_subagent exposes single-session schema and consistent sessionFile discovery hints", () => {
  const tools =
    subagentIndex.default({
      getThinkingLevel() {
        return "medium";
      },
    }).tools || [];
  const runTool = tools.find((tool) => tool.name === "run_subagent");
  assert.ok(runTool);
  assert.equal(runTool.parameters.properties.disabledExtensions.type, "array");
  assert.equal(runTool.parameters.properties.tasks, undefined);
  assert.equal(
    runTool.parameters.properties.session.properties.keep.type,
    "boolean",
  );
  assert.equal(
    runTool.parameters.properties.session.properties.sessionFile.type,
    "string",
  );
  assert.equal(runTool.parameters.properties.session.properties.ref, undefined);
  assert.match(
    runTool.parameters.properties.session.properties.sessionFile.description,
    new RegExp(
      sessionUtils
        .getDefaultSubagentSessionDir()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.match(
    sessionUtils.formatSubagentSessionFileHint(),
    new RegExp(
      sessionUtils
        .getDefaultSubagentSessionDir()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
  assert.match(
    sessionUtils.formatSubagentSessionFileRequiredError("resume"),
    /Session file is required when session.mode is resume\./,
  );
  assert.match(
    sessionUtils.formatSubagentSessionModeInvalidError("broken"),
    /Invalid session.mode: broken\. Allowed values: memory, persist, resume, fork\./,
  );
});

test("subagent session utils normalize invalid session modes and trim session files", () => {
  assert.deepEqual(
    sessionUtils.normalizeSubagentSessionConfig({
      mode: " RESUME ",
      sessionFile: "  ./sessions//managed/subagent/nested/../demo.jsonl  ",
      name: " demo ",
    }),
    {
      mode: "resume",
      sessionFile: "sessions/managed/subagent/demo.jsonl",
      name: "demo",
      keep: undefined,
    },
  );
  assert.deepEqual(
    sessionUtils.normalizeSubagentSessionConfig({
      mode: "broken",
      sessionFile: "   ",
      keep: true,
    }),
    {
      mode: "memory",
      invalidMode: "broken",
      sessionFile: undefined,
      name: undefined,
      keep: true,
    },
  );
});

test("run_subagent rejects legacy parallel task payloads", async () => {
  const result = await subagentService.executeSubagentRun({
    params: {
      prompt: undefined,
      tasks: [{ prompt: "a" }],
    },
    ctx: {
      modelRegistry: {
        async getAvailable() {
          return [];
        },
      },
    },
    currentThinkingLevel: "medium",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "run_subagent does not accept `tasks`.");
});

test("run_subagent surfaces legacy task rejection without extra hints", async () => {
  const tools =
    subagentIndex.default({
      getThinkingLevel() {
        return "medium";
      },
    }).tools || [];
  const runTool = tools.find((tool) => tool.name === "run_subagent");
  assert.ok(runTool);

  const result = await runTool.execute(
    "tool-call-1",
    { tasks: [{ prompt: "a" }] },
    undefined,
    undefined,
    {
      modelRegistry: {
        async getAvailable() {
          return [];
        },
      },
    },
  );

  assert.equal(result.isError, true);
  assert.equal(result.content?.[0]?.type, "text");
  assert.equal(
    result.content?.[0]?.text,
    "run_subagent does not accept `tasks`.",
  );
});

test("session manager can create ephemeral forks without writing a session file", async () => {
  const tempRoot = await fs.promises.mkdtemp(
    path.join(process.cwd(), "tmp-subagent-fork-"),
  );
  try {
    const sessionDir = path.join(tempRoot, "sessions");
    const source = SessionManager.create(tempRoot, sessionDir);
    source.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    source.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
      provider: "test",
      model: "demo",
    });

    const fork = subagentService.forkSessionManagerCompat(
      SessionManager,
      source.getSessionFile(),
      tempRoot,
      sessionDir,
      { persist: false },
    );
    assert.equal(fork.isPersisted(), false);
    assert.equal(fork.getSessionFile(), undefined);
    assert.equal(fork.getEntries().length, source.getEntries().length);
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
});
