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

test("Rin turn completion falls back when the captured branch leaf is no longer in the branch", () => {
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
  const newFinal = {
    role: "assistant",
    content: "new durable final",
    timestamp: 4000,
  };
  const session = {
    sessionManager: {
      getBranch: () => [
        { id: "new-user", type: "message", message: newUser },
        { id: "new-final", type: "message", message: newFinal },
      ],
      buildSessionContext: () => ({
        messages: [oldUser, oldFinal, newUser, newFinal],
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

  assert.equal(completion.finalText, "new durable final");
});
