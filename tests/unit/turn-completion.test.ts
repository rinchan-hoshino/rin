import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { resolveRinTurnCompletionAfterPromptSettled } = await import(
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

test("Rin turn completion resolves durable entries after the turn baseline when the live branch is stale", () => {
  const baseAssistant = {
    role: "assistant",
    content: "previous final must not be reused",
    timestamp: 1000,
  };
  const toolResult = {
    role: "toolResult",
    content: "validated work",
    timestamp: 2000,
  };
  const durableFinal = {
    role: "assistant",
    content: "durable final from session entries",
    timestamp: 3000,
  };
  const session = {
    sessionManager: {
      getBranch: () => [
        { id: "base-entry", type: "message", message: baseAssistant },
      ],
      getEntries: () => [
        { id: "base-entry", type: "message", message: baseAssistant },
        {
          id: "tool-result",
          parentId: "base-entry",
          type: "message",
          message: toolResult,
        },
        {
          id: "durable-final",
          parentId: "tool-result",
          type: "message",
          message: durableFinal,
        },
      ],
      buildSessionContext: () => ({
        messages: [baseAssistant],
      }),
    },
  };

  const { completion } = resolveRinTurnCompletionAfterPromptSettled(session, {
    baseline: {
      turnStartedAtMs: 2000,
      branchMessageCount: 1,
      hasBranchLeafId: true,
      branchLeafId: "base-entry",
    },
  });

  assert.equal(completion.finalText, "durable final from session entries");
});

test("Rin turn completion falls back to durable post-baseline timestamps when compaction removes the baseline leaf", () => {
  const compactedSummary = {
    role: "compactionSummary",
    content: "summary must not be delivered",
    timestamp: 2000,
  };
  const currentUser = {
    role: "user",
    content: "new prompt after compaction",
    timestamp: 3000,
  };
  const currentFinal = {
    role: "assistant",
    content: "final after compaction removed baseline leaf",
    timestamp: 4000,
  };
  const session = {
    sessionManager: {
      getBranch: () => [
        { id: "summary", type: "message", message: compactedSummary },
        {
          id: "current-user",
          parentId: "summary",
          type: "message",
          message: currentUser,
        },
        {
          id: "current-final",
          parentId: "current-user",
          type: "message",
          message: currentFinal,
        },
      ],
      getEntries: () => [
        { id: "summary", type: "message", message: compactedSummary },
        {
          id: "current-user",
          parentId: "summary",
          type: "message",
          message: currentUser,
        },
        {
          id: "current-final",
          parentId: "current-user",
          type: "message",
          message: currentFinal,
        },
      ],
      buildSessionContext: () => ({
        messages: [compactedSummary, currentUser, currentFinal],
      }),
      getLeafId: () => "current-final",
    },
  };

  const { completion } = resolveRinTurnCompletionAfterPromptSettled(session, {
    baseline: {
      turnStartedAtMs: 2500,
      branchMessageCount: 1,
      hasBranchLeafId: true,
      branchLeafId: "pre-compaction-leaf",
    },
  });

  assert.equal(
    completion.finalText,
    "final after compaction removed baseline leaf",
  );
});

test("Rin turn completion does not resolve final text from live branch or context fallbacks", () => {
  const oldUser = {
    role: "user",
    content: "old prompt",
    timestamp: 1000,
  };
  const oldFinal = {
    role: "assistant",
    content: "old final must not be reused",
    timestamp: 2000,
  };
  const newUser = {
    role: "user",
    content: "new prompt",
    timestamp: 3000,
  };
  const liveBranchFinal = {
    role: "assistant",
    content: "live branch final must not be canonical",
    timestamp: 4000,
  };
  const session = {
    sessionManager: {
      getBranch: () => [
        { id: "new-user", type: "message", message: newUser },
        { id: "new-final", type: "message", message: liveBranchFinal },
      ],
      getEntries: () => [],
      buildSessionContext: () => ({
        messages: [oldUser, oldFinal, newUser, liveBranchFinal],
      }),
    },
  };

  const { completion } = resolveRinTurnCompletionAfterPromptSettled(session, {
    baseline: {
      turnStartedAtMs: 3000,
      branchMessageCount: 2,
      hasBranchLeafId: true,
      branchLeafId: "missing-baseline-leaf",
    },
  });

  assert.equal(completion.finalText, "");
});
