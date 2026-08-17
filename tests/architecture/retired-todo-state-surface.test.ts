import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(
  path.resolve("src/core/rin-lib/todo-state.ts"),
  "utf8",
);

test("todo state keeps retired final-continuation helpers out of its public surface", () => {
  for (const retired of [
    "continueTodoFinalIfNeeded",
    "buildTodoFinalContinuationPrompt",
    "TODO_FINAL_CONTINUATION_MAX_TURNS",
  ]) {
    assert.equal(source.includes(retired), false, retired);
  }
});
