import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

await import("../support/register-memory-index-owner-fixture.ts");
const memory = await import(
  pathToFileURL(path.resolve("dist/core/memory/index.js")).href
);
const owner = globalThis as any;

const theme = {
  fg: (_name: string, value: string) => value,
  bold: (value: string) => value,
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    path: "/archive/owner.jsonl",
    summary: "Owner migration evidence",
    timestamp: "2026-07-17T08:00:00.000Z",
    score: 4,
    messages: [
      { line: 0, role: "assistant", toolName: "", text: "Owner result text" },
      { line: 9, role: "toolResult", toolName: "bash", text: "validated" },
    ],
    ...overrides,
  };
}

test("memory capability owns recall merging, formatting, rendering, updates, errors, and transcript hooks", async () => {
  owner.__rinMemoryOwnerEvents = [];
  owner.__rinMemoryOwnerFailure = "";
  owner.__rinMemoryOwnerSearchResults = [
    result({
      path: "/local-high",
      score: 9,
      timestamp: "2026-07-17T07:00:00Z",
    }),
    result({ path: "/local-low", score: 1, timestamp: "2026-07-17T09:00:00Z" }),
  ];
  owner.__rinMemoryOwnerExternalResults = [
    result({
      path: "",
      reference: "external-ref",
      score: 5,
      timestamp: "2026-07-17T08:00:00Z",
      summary: "External owner evidence",
    }),
    result({
      path: "",
      reference: "",
      provider: "notes",
      id: "owner-42",
      score: 5,
      timestamp: "2026-07-17T08:00:00Z",
      summary: "Provider result",
    }),
  ];

  const updates: any[] = [];
  const searched = await memory.executeRecall(
    { query: "  owner migration  ", limit: 3 },
    { agentDir: "/agent/owner" },
    "medium",
    undefined,
    (value: unknown) => updates.push(value),
  );
  assert.equal(updates.length, 1);
  assert.equal(
    updates[0].content[0].text,
    'Searching archived sessions for "owner migration"...',
  );
  assert.equal(updates[0].details.phase, "search");
  assert.equal(searched.name, "memory");
  assert.match(searched.content[0].text, /^recall owner migration \(3\)/);
  assert.match(searched.content[0].text, /1\. .* \/local-high/);
  assert.match(searched.content[0].text, /2\. .* external-ref/);
  assert.match(searched.content[0].text, /L1 assistant: Owner result text/);
  assert.match(searched.content[0].text, /L9 toolResult\/bash: validated/);
  assert.equal(searched.details.totalResults, 4);
  assert.equal(searched.details.hiddenCount, 1);
  assert.match(searched.details.userText, /Owner migration evidence/);
  assert.deepEqual(
    owner.__rinMemoryOwnerEvents.filter(
      ([name]: string[]) => name === "search",
    )[0],
    [
      "search",
      "owner migration",
      { query: "  owner migration  ", limit: 3, order: "relevance" },
      "/agent/owner",
    ],
  );

  owner.__rinMemoryOwnerRecentResults = [
    result({ path: "/older", timestamp: "2026-07-16T08:00:00Z" }),
    result({ path: "/newer", timestamp: "2026-07-17T10:00:00Z" }),
  ];
  owner.__rinMemoryOwnerExternalResults = [
    result({ path: "/middle", timestamp: "2026-07-17T09:00:00Z" }),
  ];
  const recentUpdates: any[] = [];
  const recent = await memory.executeRecall(
    { limit: "2" },
    { agentDir: "/agent/recent" },
    "low",
    undefined,
    (value: unknown) => recentUpdates.push(value),
  );
  assert.equal(
    recentUpdates[0].content[0].text,
    "Loading recent archived sessions...",
  );
  assert.equal(recentUpdates[0].details.phase, "recent");
  assert.match(recent.content[0].text, /^recall recent \(2\)/);
  assert.match(recent.content[0].text, /1\. .* \/newer/);
  assert.match(recent.content[0].text, /2\. .* \/middle/);

  owner.__rinMemoryOwnerRecentResults = [];
  owner.__rinMemoryOwnerExternalResults = [];
  const empty = await memory.executeRecall({}, {}, "off");
  assert.equal(empty.details.emptyMessage, "No recall results found.");
  assert.equal(empty.details.totalResults, 0);
  assert.equal(empty.content[0].text, "recall recent\n\n0 results");

  const aborted = new AbortController();
  aborted.abort();
  const abortedResult = await memory.executeRecall(
    { query: "owner" },
    {},
    "off",
    aborted.signal,
  );
  assert.equal(abortedResult.isError, true);
  assert.equal(abortedResult.content[0].text, "recall_aborted");
  assert.equal(abortedResult.details.userText, "Recall failed: recall_aborted");

  owner.__rinMemoryOwnerHoldSearch = true;
  let markSearchStarted!: () => void;
  const searchStarted = new Promise<void>((resolve) => {
    markSearchStarted = resolve;
  });
  owner.__rinMemoryOwnerSearchStarted = markSearchStarted;
  const midSearchAbort = new AbortController();
  const interruptedSearch = memory.executeRecall(
    { query: "slow owner search" },
    {},
    "off",
    midSearchAbort.signal,
  );
  await Promise.race([
    searchStarted,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("abortable transcript search did not start")),
        100,
      ),
    ),
  ]);
  midSearchAbort.abort();
  const interruptedResult = await interruptedSearch;
  assert.equal(interruptedResult.isError, true);
  assert.equal(interruptedResult.content[0].text, "recall_aborted");
  owner.__rinMemoryOwnerHoldSearch = false;
  owner.__rinMemoryOwnerSearchStarted = undefined;

  owner.__rinMemoryOwnerFailure = "search";
  const failed = await memory.executeRecall({ query: "owner" }, {}, "off");
  assert.equal(failed.isError, true);
  assert.match(failed.details.userText, /search owner failure/);
  owner.__rinMemoryOwnerFailure = "";

  assert.equal(
    memory.formatSearchResult({ results: [] }),
    "No recall results found.",
  );
  assert.equal(
    memory.formatSearchResult({ results: "invalid" }),
    "No recall results found.",
  );
  assert.equal(
    memory.formatAgentSearchResult({ query: "", results: [] }),
    "recall recent\n\n0 results",
  );
  assert.equal(
    memory.formatAgentSearchResult({ query: "owner", results: null }),
    "recall owner\n\n0 results",
  );
  assert.match(
    memory.formatSearchResult({
      results: [
        result({
          path: "",
          reference: "",
          provider: "",
          id: "",
          externalId: "",
          sessionId: "",
          summary: "",
          name: "Owner name",
          messages: [],
        }),
      ],
    }),
    /^.* Memory\nOwner name$/,
  );
  assert.match(
    memory.formatSearchResult({
      results: [
        result({
          path: "",
          reference: "",
          provider: "notes",
          id: "",
          externalId: "external-owner",
          summary: "",
          name: "",
          description: "Owner description",
        }),
      ],
    }),
    /^.* notes:external-owner\nOwner description/,
  );
  assert.match(
    memory.formatSearchResult({
      results: [
        result({
          summary: "x".repeat(300),
          messages: [{ text: "y".repeat(300) }],
        }),
      ],
    }),
    /…/,
  );

  assert.equal(
    memory.formatRecallCall({ query: " owner " }, theme),
    "recall owner",
  );
  assert.equal(memory.formatRecallCall({}, theme), "recall recent");
  const rendered = memory.formatRenderedMemoryResult(
    {
      content: [{ type: "text", text: "agent-only" }],
      details: {
        userText: "Owner-facing recall",
        hiddenCount: 2,
        totalResults: 5,
      },
    },
    { expanded: false, isPartial: false },
    theme,
    false,
    1_000,
    3_500,
  );
  assert.match(rendered, /Owner-facing recall/);
  assert.match(rendered, /Took 2\.5s/);

  const definition = memory.default({ getThinkingLevel: () => "high" });
  assert.equal(definition.tools.length, 1);
  assert.equal(definition.tools[0].name, "recall");
  const callContext: any = {
    state: {},
    executionStarted: true,
    lastComponent: undefined,
  };
  const callComponent = definition.tools[0].renderCall(
    { query: "owner" },
    theme,
    callContext,
  );
  assert.equal(callContext.state.startedAt > 0, true);
  assert.match(callComponent.render(80).join("\n"), /recall owner/);
  const reusedCall = definition.tools[0].renderCall({}, theme, {
    ...callContext,
    lastComponent: callComponent,
  });
  assert.equal(reusedCall, callComponent);

  const renderContext: any = {
    state: { startedAt: Date.now() - 10 },
    invalidateCalls: 0,
    invalidate() {
      this.invalidateCalls += 1;
    },
    showImages: false,
    isError: false,
  };
  const partialComponent = definition.tools[0].renderResult(
    {
      content: [{ type: "text", text: "partial" }],
      details: { userText: "partial" },
    },
    { expanded: false, isPartial: true },
    theme,
    renderContext,
  );
  assert.ok(renderContext.state.interval);
  const finalComponent = definition.tools[0].renderResult(
    {
      content: [{ type: "text", text: "done" }],
      details: { userText: "done" },
    },
    { expanded: true, isPartial: false },
    theme,
    { ...renderContext, lastComponent: partialComponent },
  );
  assert.equal(finalComponent, partialComponent);
  assert.equal(renderContext.state.interval, undefined);
  assert.equal(renderContext.state.endedAt > 0, true);

  owner.__rinMemoryOwnerSearchResults = [result({ path: "/tool" })];
  owner.__rinMemoryOwnerExternalResults = [];
  const toolResult = await definition.tools[0].execute(
    "tool-owner",
    { query: "tool" },
    undefined,
    undefined,
    { agentDir: "/agent/tool" },
  );
  assert.equal(toolResult.name, "memory");

  const messageHook = definition.hooks.message_end[0];
  await messageHook(
    {
      message: {
        id: "message-owner",
        timestamp: "",
        role: "assistant",
        content: [{ type: "text", text: "Durable owner evidence" }],
        display: true,
      },
    },
    {
      agentDir: "/agent/hook",
      sessionId: "session-hook",
      sessionFile: "/sessions/hook.jsonl",
    },
  );
  assert.equal(
    owner.__rinMemoryOwnerEvents.some(
      ([name, input]: any[]) =>
        name === "archive" &&
        input.role === "assistant" &&
        input.text === "Durable owner evidence",
    ),
    true,
  );
  assert.equal(
    owner.__rinMemoryOwnerEvents.some(
      ([name]: string[]) => name === "external-write",
    ),
    true,
  );

  owner.__rinMemoryOwnerArchiveFailure = true;
  owner.__rinMemoryOwnerExternalWriteFailure = true;
  await messageHook(
    { message: { role: "assistant", content: "settled failures" } },
    {
      agentDir: "/agent/hook",
      sessionId: "session-hook",
      sessionFile: "/sessions/hook.jsonl",
    },
  );
  owner.__rinMemoryOwnerArchiveFailure = false;
  owner.__rinMemoryOwnerExternalWriteFailure = false;
  await messageHook(
    { message: { role: "assistant", content: "missing session" } },
    { agentDir: "/agent/hook" },
  );
  await messageHook({ message: null }, { agentDir: "/agent/hook" });
});
