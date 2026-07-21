import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const {
  areRinTurnTerminalOutcomesConsistent,
  classifyRinTurnMessage,
  resolveRinAuthoritativeTurnTerminalOutcome,
  resolveRinTurnCompletionFromAssistantMessage,
  resolveRinTurnCompletionFromTurnResult,
  resolveRinTurnTerminalOutcomeFromAssistantMessage,
  resolveRinTurnTerminalOutcomeFromMessages,
  resolveRinTurnTerminalOutcomeFromTurnResult,
} = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-frontend-sdk",
      "turn-completion.js",
    ),
  ).href
);

test("Rin turn completion resolves explicit TurnResult payloads", () => {
  const { completion } = resolveRinTurnCompletionFromTurnResult({
    messages: [{ type: "text", text: "explicit final" }],
  });

  assert.equal(completion.finalText, "explicit final");
});

test("Rin turn completion resolves the current assistant message_end", () => {
  const resolution = resolveRinTurnCompletionFromAssistantMessage({
    role: "assistant",
    content: [{ type: "text", text: "message_end final" }],
  });

  assert.equal(resolution?.completion.finalText, "message_end final");
});

test("Rin turn completion does not treat assistant tool-call prefaces as finals", () => {
  const resolution = resolveRinTurnCompletionFromAssistantMessage({
    role: "assistant",
    content: [
      { type: "text", text: "not final" },
      { type: "toolCall", name: "read", id: "call-1" },
    ],
  });

  assert.equal(resolution, null);
});

test("Rin turn completion classifies structured summaries before assistant terminals", () => {
  const summaries = [
    {
      type: "compaction",
      role: "assistant",
      content: [{ type: "text", text: "raw compaction summary" }],
    },
    {
      role: "compactionSummary",
      content: [{ type: "text", text: "raw compaction summary" }],
    },
    {
      role: "branchSummary",
      content: [{ type: "text", text: "raw branch summary" }],
    },
    {
      role: "assistant",
      customType: "session_summary",
      content: [{ type: "text", text: "raw session summary" }],
    },
    {
      role: "assistant",
      summaryEntry: { id: "summary" },
      content: [{ type: "text", text: "raw session summary" }],
    },
    {
      type: "compaction",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "wrapped compaction summary" }],
      },
    },
    {
      summaryEntry: { id: "outer-summary" },
      message: {
        role: "assistant",
        content: [{ type: "text", text: "wrapped session summary" }],
      },
    },
  ];

  for (const summary of summaries) {
    assert.equal(classifyRinTurnMessage(summary), "nonterminal");
    assert.equal(resolveRinTurnCompletionFromAssistantMessage(summary), null);
  }
});

test("Rin turn completion classifies failed and deliverable assistant terminals", () => {
  assert.equal(
    classifyRinTurnMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "provider failed",
      content: [],
    }),
    "error",
  );
  assert.equal(
    classifyRinTurnMessage({
      role: "assistant",
      content: [{ type: "image", data: "abc" }],
    }),
    "complete",
  );
  assert.deepEqual(
    resolveRinTurnTerminalOutcomeFromAssistantMessage({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "wrapped provider failure",
        content: [],
      },
    }),
    {
      kind: "error",
      resolution: {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "wrapped provider failure",
            content: [],
          },
        ],
        completion: { finalText: "", result: { messages: [] } },
      },
      error: "wrapped provider failure",
    },
  );
});

test("Rin turn terminal outcomes distinguish absent from explicit empty and media-only complete", () => {
  assert.deepEqual(resolveRinTurnTerminalOutcomeFromTurnResult(undefined), {
    kind: "absent",
  });
  assert.equal(
    resolveRinTurnTerminalOutcomeFromTurnResult({ messages: [] }).kind,
    "complete",
  );
  assert.equal(
    resolveRinTurnTerminalOutcomeFromTurnResult({
      messages: [{ type: "text", text: "structured deliverable" }],
    }).kind,
    "complete",
  );
  assert.equal(
    resolveRinTurnTerminalOutcomeFromTurnResult({
      messages: [
        {
          type: "compaction",
          role: "assistant",
          content: [{ type: "text", text: "summary only" }],
        },
      ],
    }).kind,
    "absent",
  );
  assert.equal(
    resolveRinTurnTerminalOutcomeFromTurnResult({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "provider failed",
          content: [],
        },
      ],
    }).kind,
    "error",
  );
  const media = resolveRinTurnTerminalOutcomeFromAssistantMessage({
    role: "assistant",
    content: [{ type: "image", data: "abc" }],
  });
  assert.equal(media.kind, "complete");
  assert.deepEqual(media.resolution.completion.result.messages, [
    { type: "image", data: "abc", mimeType: "image/png" },
  ]);
});

test("Rin turn terminal outcome consistency compares canonical content without treating absent as conflict", () => {
  const absent = resolveRinTurnTerminalOutcomeFromTurnResult(undefined);
  const text = resolveRinTurnTerminalOutcomeFromTurnResult({
    finalText: "done",
  });
  const same = resolveRinTurnTerminalOutcomeFromAssistantMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  });
  const different = resolveRinTurnTerminalOutcomeFromAssistantMessage({
    role: "assistant",
    content: [{ type: "text", text: "different" }],
  });

  assert.equal(areRinTurnTerminalOutcomesConsistent(text, absent), true);
  assert.equal(areRinTurnTerminalOutcomesConsistent(text, same), true);
  assert.equal(areRinTurnTerminalOutcomesConsistent(text, different), false);
});

test("Rin turn terminal authority never promotes observed events over durable scope", () => {
  const absent = resolveRinTurnTerminalOutcomeFromTurnResult(undefined);
  const observed = resolveRinTurnTerminalOutcomeFromMessages([
    {
      role: "assistant",
      content: [{ type: "text", text: "observed only" }],
    },
  ]);
  const scoped = resolveRinTurnTerminalOutcomeFromMessages([
    {
      role: "assistant",
      content: [{ type: "text", text: "durable" }],
    },
  ]);
  const direct = resolveRinTurnTerminalOutcomeFromTurnResult({
    finalText: "explicit",
  });

  assert.equal(
    resolveRinAuthoritativeTurnTerminalOutcome(absent, absent, observed).kind,
    "absent",
  );
  assert.equal(
    resolveRinAuthoritativeTurnTerminalOutcome(direct, absent, absent),
    direct,
  );
  assert.equal(
    resolveRinAuthoritativeTurnTerminalOutcome(absent, scoped, scoped),
    scoped,
  );
  assert.throws(
    () => resolveRinAuthoritativeTurnTerminalOutcome(absent, scoped, observed),
    /rin_turn_terminal_conflict/,
  );
});
