import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const presentation = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/command-result-presentation.js")
>("dist/core/rin-frontend-sdk/command-result-presentation.js");

test("command result presentation owns every built-in result family and sparse fallback", () => {
  assert.deepEqual(presentation.presentBuiltinCommandResult(undefined), {});
  assert.match(
    presentation.formatSessionStats(undefined),
    /Session File: In-memory/,
  );

  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "changelog",
      data: { entries: [" first ", "", 2] },
    }).text,
    "first\n\n2",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({ command: "changelog" }).text,
    "No changelog entries found.",
  );

  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "resume",
      data: { resumedSessionId: " session-1 " },
    }).text,
    "Resumed session: session-1",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "resume",
      data: {
        sessions: [
          null,
          { id: "" },
          { id: "session-2", name: "" },
          { id: "session-3", name: " Named " },
        ],
      },
    }).text,
    "Available sessions:\nsession-2 — session-2\nsession-3 — Named",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({ command: "resume" }).text,
    "No sessions available.",
  );

  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "model",
      data: { selectedModel: " provider/model ", thinkingLevel: " high " },
    }).text,
    "Model set to: provider/model (high)",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "model",
      data: { selectedModel: "provider/model" },
    }).text,
    "Model set to: provider/model",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({
      command: "model",
      data: { models: [" one ", "", 2] },
    }).text,
    "Available models:\none\n2",
  );
  assert.equal(
    presentation.presentBuiltinCommandResult({ command: "model" }).text,
    "No models available.",
  );
});
