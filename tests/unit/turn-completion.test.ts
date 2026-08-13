import test from "node:test";
import assert from "node:assert/strict";

import { importBuiltModule } from "../support/import-built-module.js";

const {
  areRinTurnTerminalOutcomesConsistent,
  classifyRinTurnMessage,
  RinTurnSettlementProjector,
  resolveRinAuthoritativeTurnTerminalOutcome,
  resolveRinTurnCompletionFromAssistantMessage,
  resolveRinTurnCompletionFromTurnResult,
  resolveRinSettledTurnTerminalOutcomeFromMessages,
  resolveRinTerminalTurnCompletionFromMessages,
  resolveRinTurnFailureMessage,
  resolveRinTurnTerminalOutcomeFromAssistantMessage,
  resolveRinTurnTerminalOutcomeFromMessages,
  resolveRinTurnTerminalOutcomeFromTurnResult,
} = await importBuiltModule<
  typeof import("../../src/core/session/turn-completion.js")
>("dist/core/session/turn-completion.js");

test("Rin turn completion resolves explicit TurnResult payloads", () => {
  const { completion } = resolveRinTurnCompletionFromTurnResult({
    messages: [{ type: "text", text: "explicit final" }],
  });

  assert.equal(completion.finalText, "explicit final");
});

test("Rin rejects an empty producer result as a terminal error", () => {
  assert.deepEqual(
    resolveRinTurnTerminalOutcomeFromTurnResult({ messages: [] }),
    {
      kind: "error",
      resolution: {
        messages: [],
        completion: { finalText: "", result: { messages: [] } },
      },
      error: "Agent returned an empty response.",
    },
  );
  assert.equal(
    resolveRinTurnTerminalOutcomeFromAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "stop",
    }).kind,
    "error",
  );
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

test("Rin turn settlement projector owns session observation and settled authority", () => {
  let listener: ((event: any) => void) | undefined;
  let unsubscribed = false;
  const settledOutcomes: any[] = [];
  const session = {
    subscribe(callback: (event: any) => void) {
      listener = callback;
      return () => {
        unsubscribed = true;
      };
    },
  };
  const projector = new RinTurnSettlementProjector(session, (outcome) => {
    settledOutcomes.push(outcome);
  });
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "durable tool preface" },
        { type: "toolCall", name: "todo", id: "call-1" },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      content: [],
      isError: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "stop",
    },
  ];
  for (const message of messages) listener?.({ type: "message_end", message });

  const beforeSettlement = projector.resolve({ kind: "absent" }, messages);
  assert.equal(beforeSettlement.kind, "error");
  assert.equal(beforeSettlement.error, "Agent returned an empty response.");

  listener?.({ type: "agent_settled" });
  assert.equal(settledOutcomes.length, 1);
  assert.equal(
    settledOutcomes[0].resolution.completion.finalText,
    "durable tool preface",
  );
  assert.equal(
    projector.resolve({ kind: "absent" }, messages).resolution.completion
      .finalText,
    "durable tool preface",
  );
  assert.equal(
    projector.resolveUnsettled({ kind: "absent" }, messages).resolution
      .completion.finalText,
    "",
  );

  const unsettledContinuation = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "later unsettled preface" },
        { type: "toolCall", name: "todo", id: "call-2" },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-2",
      content: [],
      isError: false,
    },
    {
      role: "assistant",
      content: [],
      stopReason: "stop",
    },
  ];
  for (const message of unsettledContinuation) {
    listener?.({ type: "message_end", message });
  }
  const messagesAfterSettledBoundary = [...messages, ...unsettledContinuation];
  assert.equal(
    projector.resolve({ kind: "absent" }, messagesAfterSettledBoundary)
      .resolution.completion.finalText,
    "",
  );
  listener?.({ type: "agent_settled" });
  assert.equal(settledOutcomes.length, 2);
  assert.equal(
    projector.resolve({ kind: "absent" }, messagesAfterSettledBoundary)
      .resolution.completion.finalText,
    "later unsettled preface",
  );

  projector.reset();
  assert.equal(
    projector.resolve({ kind: "absent" }, messages).resolution.completion
      .finalText,
    "",
  );
  projector.dispose();
  assert.equal(unsubscribed, true);
});

test("Rin settled completion promotes a successful durable tool preface only when no deliverable terminal follows", () => {
  const toolPreface = {
    role: "assistant",
    content: [
      { type: "text", text: "durable tool preface" },
      { type: "toolCall", name: "todo", id: "call-1" },
    ],
    stopReason: "toolUse",
  };
  const successfulToolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    content: [],
    isError: false,
  };
  const emptyStop = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "stop",
  };

  const afterEmpty = resolveRinSettledTurnTerminalOutcomeFromMessages([
    toolPreface,
    successfulToolResult,
    emptyStop,
  ]);
  assert.equal(afterEmpty.kind, "complete");
  assert.equal(
    afterEmpty.resolution.completion.finalText,
    "durable tool preface",
  );
  assert.deepEqual(afterEmpty.resolution.completion.result.messages, [
    { type: "text", text: "durable tool preface" },
  ]);

  const afterSuccessfulToolOnlyContinuation =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      toolPreface,
      successfulToolResult,
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", id: "call-2" }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        content: [],
        isError: false,
      },
      emptyStop,
    ]);
  assert.equal(afterSuccessfulToolOnlyContinuation.kind, "complete");
  assert.equal(
    afterSuccessfulToolOnlyContinuation.resolution.completion.finalText,
    "durable tool preface",
  );

  const laterPostToolText = resolveRinSettledTurnTerminalOutcomeFromMessages([
    toolPreface,
    successfulToolResult,
    {
      role: "assistant",
      content: [
        { type: "toolCall", name: "read", id: "call-3" },
        { type: "text", text: "later durable post-tool text" },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-3",
      content: [],
      isError: false,
    },
    emptyStop,
  ]);
  assert.equal(laterPostToolText.kind, "complete");
  assert.equal(
    laterPostToolText.resolution.completion.finalText,
    "later durable post-tool text",
  );

  const toolShapedSummary = {
    type: "compaction",
    role: "assistant",
    content: [
      { type: "text", text: "summary must stay outside tool authority" },
      { type: "toolCall", name: "read", id: "summary-call" },
    ],
  };
  for (const messages of [
    [toolPreface, successfulToolResult, toolShapedSummary, emptyStop],
    [toolPreface, successfulToolResult, emptyStop, toolShapedSummary],
  ]) {
    const aroundSummary =
      resolveRinSettledTurnTerminalOutcomeFromMessages(messages);
    assert.equal(aroundSummary.kind, "complete");
    assert.equal(
      aroundSummary.resolution.completion.finalText,
      "durable tool preface",
    );
  }

  for (const messages of [
    [
      toolPreface,
      successfulToolResult,
      { type: "notification", role: "assistant", content: [] },
      emptyStop,
    ],
    [
      toolPreface,
      successfulToolResult,
      emptyStop,
      { type: "fragment", role: "assistant", content: [] },
    ],
    [
      toolPreface,
      successfulToolResult,
      { role: " assistant ", content: [] },
      emptyStop,
    ],
  ]) {
    const aroundUnknownRecord =
      resolveRinSettledTurnTerminalOutcomeFromMessages(messages);
    assert.equal(aroundUnknownRecord.kind, "error");
    assert.equal(
      aroundUnknownRecord.error,
      "Agent returned an empty response.",
    );
  }

  const canonicalFinal = resolveRinSettledTurnTerminalOutcomeFromMessages([
    toolPreface,
    successfulToolResult,
    {
      role: "assistant",
      content: [{ type: "text", text: "later canonical final" }],
      stopReason: "stop",
    },
  ]);
  assert.equal(canonicalFinal.kind, "complete");
  assert.equal(
    canonicalFinal.resolution.completion.finalText,
    "later canonical final",
  );
});

test("Rin settled completion preserves error, media, summary, and failed-tool boundaries", () => {
  const assertEmptyResponseError = (outcome: any) => {
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.error, "Agent returned an empty response.");
  };
  const preface = {
    role: "assistant",
    content: [
      { type: "text", text: "must not override the settled boundary" },
      { type: "toolCall", name: "read", id: "call-boundary" },
    ],
    stopReason: "toolUse",
  };

  const failed = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", id: "call-later" }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-later",
      content: [{ type: "text", text: "later read failed" }],
      isError: true,
    },
    { role: "assistant", content: [], stopReason: "stop" },
  ]);
  assert.equal(failed.kind, "error");
  assert.equal(failed.error, "Agent returned an empty response.");

  for (const stopReason of [undefined, " stop "]) {
    const implicitOrMalformedEmptyTerminal =
      resolveRinSettledTurnTerminalOutcomeFromMessages([
        preface,
        {
          role: "toolResult",
          toolCallId: "call-boundary",
          content: [],
          isError: false,
        },
        {
          role: "assistant",
          content: [],
          ...(stopReason === undefined ? {} : { stopReason }),
        },
      ]);
    assertEmptyResponseError(implicitOrMalformedEmptyTerminal);
  }

  for (const isError of [undefined, "false"]) {
    const implicitOrMalformedToolSuccess =
      resolveRinSettledTurnTerminalOutcomeFromMessages([
        preface,
        {
          role: "toolResult",
          toolCallId: "call-boundary",
          content: [],
          ...(isError === undefined ? {} : { isError }),
        },
        { role: "assistant", content: [], stopReason: "stop" },
      ]);
    assertEmptyResponseError(implicitOrMalformedToolSuccess);
  }

  for (const stopReason of [undefined, "stop", " toolUse "]) {
    const implicitOrMalformedToolUse =
      resolveRinSettledTurnTerminalOutcomeFromMessages([
        {
          role: "assistant",
          content: preface.content,
          ...(stopReason === undefined ? {} : { stopReason }),
        },
        {
          role: "toolResult",
          toolCallId: "call-boundary",
          content: [],
          isError: false,
        },
        { role: "assistant", content: [], stopReason: "stop" },
      ]);
    assertEmptyResponseError(implicitOrMalformedToolUse);
  }

  const earlierEmptyTerminal = resolveRinSettledTurnTerminalOutcomeFromMessages(
    [
      preface,
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
      { role: "assistant", content: [], stopReason: "stop" },
    ],
  );
  assertEmptyResponseError(earlierEmptyTerminal);

  const emptyToolUseContinuation =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      preface,
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "toolUse" },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(emptyToolUseContinuation);

  const errorThenEmpty = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "failed attempt before empty stop",
    },
    { role: "assistant", content: [], stopReason: "stop" },
  ]);
  assertEmptyResponseError(errorThenEmpty);

  const resultAfterTerminal = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    { role: "assistant", content: [], stopReason: "stop" },
    {
      role: "toolResult",
      toolCallId: "unexpected-after-terminal",
      content: [],
      isError: false,
    },
  ]);
  assertEmptyResponseError(resultAfterTerminal);

  const outOfOrderToolResults =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "must preserve tool result order" },
          { type: "toolCall", name: "read", id: "call-order-a" },
          { type: "toolCall", name: "read", id: "call-order-b" },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-order-b",
        content: [],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call-order-a",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(outOfOrderToolResults);

  const overlappingToolCycles =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "must settle each tool cycle" },
          { type: "toolCall", name: "read", id: "call-cycle-a" },
        ],
        stopReason: "toolUse",
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", id: "call-cycle-b" }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-cycle-a",
        content: [],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "call-cycle-b",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(overlappingToolCycles);

  const normalizedToolIdMismatch =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "tool IDs are opaque" },
          { type: "toolCall", name: "read", id: " call-exact" },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-exact",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(normalizedToolIdMismatch);

  const distinctWhitespaceToolIds =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "distinct opaque tool IDs" },
          { type: "toolCall", name: "read", id: "call-space" },
          { type: "toolCall", name: "read", id: " call-space" },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-space",
        content: [],
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: " call-space",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assert.equal(distinctWhitespaceToolIds.kind, "complete");
  assert.equal(
    distinctWhitespaceToolIds.resolution.completion.finalText,
    "distinct opaque tool IDs",
  );

  const duplicateToolCallId = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", id: "call-boundary" }],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    { role: "assistant", content: [], stopReason: "stop" },
  ]);
  assertEmptyResponseError(duplicateToolCallId);

  const orphanFailedResult = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "orphan-failure",
      content: [{ type: "text", text: "orphan failed" }],
      isError: true,
    },
    { role: "assistant", content: [], stopReason: "stop" },
  ]);
  assertEmptyResponseError(orphanFailedResult);

  const toolTerminated = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
  ]);
  assert.equal(toolTerminated.kind, "absent");

  const toolCallAsFinalStop = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "toolResult",
      toolCallId: "call-boundary",
      content: [],
      isError: false,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", id: "call-final" }],
      stopReason: "stop",
    },
  ]);
  assert.equal(toolCallAsFinalStop.kind, "absent");

  const toolCallWithStopReasonStop =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      preface,
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        content: [],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", id: "call-malformed" }],
        stopReason: "stop",
      },
      {
        role: "toolResult",
        toolCallId: "call-malformed",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(toolCallWithStopReasonStop);

  const emptyToolUseWithoutCall =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      preface,
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        content: [],
        isError: false,
      },
      { role: "assistant", content: [], stopReason: "toolUse" },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(emptyToolUseWithoutCall);

  const unsupportedEmptyTerminalContent =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      preface,
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        content: [],
        isError: false,
      },
      {
        role: "assistant",
        content: [{ type: "custom", value: "not a Pi assistant part" }],
        stopReason: "stop",
      },
    ]);
  assertEmptyResponseError(unsupportedEmptyTerminalContent);

  const ordinaryTextThenEmpty =
    resolveRinSettledTurnTerminalOutcomeFromMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "ordinary prior final" }],
        stopReason: "stop",
      },
      { role: "assistant", content: [], stopReason: "stop" },
    ]);
  assertEmptyResponseError(ordinaryTextThenEmpty);

  const providerError = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider failed",
    },
  ]);
  assert.equal(providerError.kind, "error");
  assert.equal(providerError.error, "provider failed");

  const media = resolveRinSettledTurnTerminalOutcomeFromMessages([
    preface,
    {
      role: "assistant",
      content: [{ type: "image", data: "abc", mimeType: "image/webp" }],
      stopReason: "stop",
    },
  ]);
  assert.equal(media.kind, "complete");
  assert.deepEqual(media.resolution.completion.result.messages, [
    { type: "image", data: "abc", mimeType: "image/webp" },
  ]);

  const summaryOnly = resolveRinSettledTurnTerminalOutcomeFromMessages([
    {
      type: "compaction",
      role: "assistant",
      content: [{ type: "text", text: "raw summary" }],
    },
    { role: "assistant", content: [], stopReason: "stop" },
  ]);
  assertEmptyResponseError(summaryOnly);
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
    "error",
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

test("Rin terminal compatibility and failure helpers preserve explicit errors", () => {
  assert.equal(resolveRinTerminalTurnCompletionFromMessages([]), null);
  assert.equal(
    resolveRinTerminalTurnCompletionFromMessages([
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ])?.completion.finalText,
    "done",
  );

  assert.equal(
    resolveRinTurnFailureMessage({}, [
      { role: "user" },
      { role: "assistant", errorMessage: " explicit failure " },
    ]),
    "explicit failure",
  );
  assert.equal(
    resolveRinTurnFailureMessage({}, [
      { role: "assistant", stopReason: "aborted", content: [] },
    ]),
    "Agent turn was aborted.",
  );
  assert.equal(
    resolveRinTurnFailureMessage({}, [
      { role: "assistant", stopReason: "error", content: [] },
    ]),
    "Agent producer failed.",
  );
  assert.equal(
    resolveRinTurnFailureMessage(
      { agent: { state: { errorMessage: " state failure " } } },
      [],
    ),
    "state failure",
  );
  assert.equal(resolveRinTurnFailureMessage({}, []), "");
});

test("Rin terminal consistency covers errors and structured results", () => {
  const completion = (text: string) => ({
    kind: "complete" as const,
    comparison: "structured" as const,
    resolution: {
      messages: [],
      completion: {
        finalText: text,
        result: { messages: [{ type: "text", text }] },
      },
    },
  });
  const error = (message: string) => ({
    kind: "error" as const,
    error: message,
    resolution: {
      messages: [],
      completion: { finalText: "", result: { messages: [] } },
    },
  });
  assert.equal(
    areRinTurnTerminalOutcomesConsistent(error("one"), completion("one")),
    false,
  );
  assert.equal(
    areRinTurnTerminalOutcomesConsistent(error(""), error("two")),
    true,
  );
  assert.equal(
    areRinTurnTerminalOutcomesConsistent(error("one"), error("two")),
    false,
  );
  assert.equal(
    areRinTurnTerminalOutcomesConsistent(completion("one"), completion("one")),
    true,
  );
  assert.equal(
    areRinTurnTerminalOutcomesConsistent(completion("one"), completion("two")),
    false,
  );
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
