import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const admission = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "durable-admission.js"),
  ).href
);

const turn = { chatKey: "telegram/1:2", messageId: "m1" };
const frozen = {
  version: 1,
  chatKey: turn.chatKey,
  incomingMessageId: turn.messageId,
  text: "frozen prompt",
  attachments: [],
  promptMeta: { chatKey: turn.chatKey, sentAt: 1234 },
  sessionFile: "prepared.jsonl",
};
const messageDecision = {
  version: 1,
  kind: "message",
  decision: { allow: true },
};

test("durable admission resolves only integrity-verified message submissions", () => {
  assert.deepEqual(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: messageDecision,
        decisionIntegrity: "valid",
        submission: frozen,
        submissionIntegrity: "valid",
        executionSessionFile: "accepted.jsonl",
      },
      turn,
    ),
    {
      kind: "turn",
      submission: { ...frozen, sessionFile: "accepted.jsonl" },
    },
  );
  for (const candidate of [
    {
      state: "actionable",
      decision: { version: 1, kind: "legacy_message_projection" },
    },
    {
      state: "actionable",
      decision: messageDecision,
      decisionIntegrity: "valid",
      submission: frozen,
      submissionIntegrity: "invalid",
    },
    {
      state: "actionable",
      decision: messageDecision,
      decisionIntegrity: "invalid",
      submission: frozen,
      submissionIntegrity: "valid",
    },
    {
      state: "actionable",
      decision: messageDecision,
      decisionIntegrity: "valid",
      submission: { ...frozen, attachments: "invalid" },
      submissionIntegrity: "valid",
    },
    {
      state: "actionable",
      decision: messageDecision,
      decisionIntegrity: "valid",
      submission: { ...frozen, chatKey: ` ${turn.chatKey} ` },
      submissionIntegrity: "valid",
    },
    {
      state: "actionable",
      decision: messageDecision,
      decisionIntegrity: "valid",
      submission: { ...frozen, promptMeta: { sentAt: "invalid" } },
      submissionIntegrity: "valid",
    },
  ]) {
    assert.equal(
      admission.resolveDurableChatAdmission(candidate, turn).kind,
      "interrupted_unknown",
    );
  }
  assert.deepEqual(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: messageDecision,
        decisionIntegrity: "valid",
        submission: frozen,
        submissionIntegrity: "valid",
      },
      { chatKey: turn.chatKey, messageId: "different-message" },
    ),
    { kind: "interrupted_unknown", reason: "unsupported_admission" },
  );
});

test("durable admission validates frozen command identity and integrity", () => {
  const commandDecision = {
    version: 1,
    kind: "command",
    chatKey: turn.chatKey,
    messageId: turn.messageId,
    command: { name: "new", argsText: "" },
    trust: "OWNER",
    promptMeta: { chatKey: turn.chatKey, identity: "OWNER" },
  };
  assert.deepEqual(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: commandDecision,
        decisionIntegrity: "valid",
      },
      turn,
    ),
    {
      kind: "command",
      chatKey: turn.chatKey,
      messageId: turn.messageId,
      command: { name: "new", argsText: "" },
      promptMeta: { chatKey: turn.chatKey, identity: "OWNER" },
    },
  );
  for (const candidate of [
    { ...commandDecision, messageId: "different-message" },
    { ...commandDecision, chatKey: ` ${turn.chatKey} ` },
    {
      ...commandDecision,
      command: { name: " new ", argsText: "" },
    },
    {
      ...commandDecision,
      command: { name: "new", argsText: " argument " },
    },
    {
      ...commandDecision,
      promptMeta: {
        chatKey: turn.chatKey,
        identity: "OWNER",
        sentAt: "invalid",
      },
    },
    {
      ...commandDecision,
      promptMeta: { chatKey: "telegram/other:chat", identity: "OWNER" },
    },
    {
      ...commandDecision,
      promptMeta: { chatKey: turn.chatKey, identity: "STRANGER" },
    },
  ]) {
    assert.equal(
      admission.resolveDurableChatAdmission(
        {
          state: "actionable",
          decision: candidate,
          decisionIntegrity: "valid",
        },
        turn,
      ).kind,
      "interrupted_unknown",
    );
  }
  assert.equal(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: commandDecision,
        decisionIntegrity: "invalid",
      },
      turn,
    ).kind,
    "interrupted_unknown",
  );
  assert.equal(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: {
          version: 1,
          kind: "unmatched_command",
          chatKey: turn.chatKey,
          messageId: ` ${turn.messageId} `,
          name: "future-command",
          trust: "OWNER",
          respond: true,
        },
        decisionIntegrity: "valid",
      },
      turn,
    ).kind,
    "interrupted_unknown",
  );
  assert.deepEqual(
    admission.resolveDurableChatAdmission(
      {
        state: "actionable",
        decision: {
          version: 1,
          kind: "unmatched_command",
          chatKey: turn.chatKey,
          messageId: turn.messageId,
          name: "future-command",
          trust: "OWNER",
          respond: false,
        },
        decisionIntegrity: "valid",
      },
      turn,
    ),
    {
      kind: "unmatched_command",
      chatKey: turn.chatKey,
      messageId: turn.messageId,
      name: "future-command",
      respond: false,
    },
  );
  assert.deepEqual(
    admission.resolveDurableChatAdmission(
      {
        state: "record_only",
        decision: { version: 1, kind: "record_only_chat" },
        decisionIntegrity: "valid",
      },
      turn,
    ),
    { kind: "record_only" },
  );
  assert.equal(
    admission.durableAdmissionMatchesTurn(
      { state: "record_only", decision: commandDecision },
      turn,
    ),
    false,
  );
  for (const candidate of [
    {
      state: "record_only",
      decision: { version: 1, kind: "record_only_chat" },
      decisionIntegrity: "invalid",
    },
    {
      state: "record_only",
      decision: commandDecision,
      decisionIntegrity: "valid",
    },
    {
      state: "record_only",
      decision: { version: 1, kind: "record_only_chat" },
      decisionIntegrity: "valid",
      submissionIntegrity: "invalid",
    },
    {
      state: "actionable",
      decision: commandDecision,
      decisionIntegrity: "valid",
      submissionIntegrity: "invalid",
    },
    {
      state: "unclassified",
      decision: commandDecision,
      decisionIntegrity: "invalid",
    },
    {
      state: "unclassified",
      stateIntegrity: "invalid",
    },
  ]) {
    assert.equal(
      admission.resolveDurableChatAdmission(candidate, turn).kind,
      "interrupted_unknown",
    );
  }
});
