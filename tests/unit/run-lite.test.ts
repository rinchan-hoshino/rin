import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const runLite = await importBuiltModule<{
  printRunHelp(): void;
  shouldRunNonInteractive(argv: string[], stdinIsTTY?: boolean): boolean;
}>("dist/core/rin/run-lite.js");

test("run-lite detects explicit print and JSON modes before the option terminator", () => {
  for (const argv of [
    ["-p"],
    ["--print"],
    ["--mode", "json"],
    ["--mode=json"],
  ]) {
    assert.equal(runLite.shouldRunNonInteractive(argv, true), true);
  }
  assert.equal(runLite.shouldRunNonInteractive(["--", "-p"], true), false);
  assert.equal(
    runLite.shouldRunNonInteractive(["--mode", "text"], true),
    false,
  );
  assert.equal(runLite.shouldRunNonInteractive([], false), true);
  assert.equal(runLite.shouldRunNonInteractive([], true), false);
});

test("run-lite help documents managed sessions and bounded execution", () => {
  const lines: string[] = [];
  const original = console.log;
  try {
    console.log = (value?: unknown) => lines.push(String(value ?? ""));
    runLite.printRunHelp();
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /--managed-session <leaf>/);
  assert.match(lines[0], /--timeout <seconds>/);
  assert.match(lines[0], /--no-builtin-tools/);
});
