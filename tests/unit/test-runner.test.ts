import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildNodeTestArgs,
  discoverTestFiles,
} from "../../scripts/run-tests.ts";

test("test runner discovers one suite recursively in stable order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-test-runner-"));
  try {
    fs.mkdirSync(path.join(root, "tests", "unit", "nested"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, "tests", "e2e"), { recursive: true });
    fs.writeFileSync(path.join(root, "tests", "unit", "z.test.ts"), "");
    fs.writeFileSync(
      path.join(root, "tests", "unit", "nested", "a.test.ts"),
      "",
    );
    fs.writeFileSync(path.join(root, "tests", "unit", "ignored.ts"), "");
    fs.writeFileSync(path.join(root, "tests", "e2e", "other.test.ts"), "");

    assert.deepEqual(discoverTestFiles(root, "unit"), [
      path.join(root, "tests", "unit", "nested", "a.test.ts"),
      path.join(root, "tests", "unit", "z.test.ts"),
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test runner builds explicit node test arguments", () => {
  assert.deepEqual(buildNodeTestArgs(["b.test.ts", "a.test.ts"], 4), [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=4",
    "b.test.ts",
    "a.test.ts",
  ]);
});

test("test runner rejects an empty suite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rin-test-runner-"));
  try {
    assert.throws(
      () => discoverTestFiles(root, "unit"),
      /rin_test_suite_empty:unit/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
