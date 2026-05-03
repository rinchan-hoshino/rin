import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const formatCheckScript = await import(
  pathToFileURL(path.join(rootDir, "scripts", "run-format-check.mjs")).href
);

test("run-format-check builds default prettier check arguments", () => {
  assert.deepEqual(formatCheckScript.buildPrettierFormatCheckArgs(), [
    "--check",
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ".",
  ]);
});

test("run-format-check preserves explicit prettier check targets", () => {
  const targets = ["src/core/rin/main.ts", "tests/unit/rin-cli.test.ts"];

  assert.deepEqual(formatCheckScript.buildPrettierFormatCheckArgs(targets), [
    "--check",
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ...targets,
  ]);
});

test("run-format-check builds prettier write arguments", () => {
  const targets = ["src/core/rin/main.ts"];

  assert.deepEqual(formatCheckScript.buildPrettierFormatWriteArgs(targets), [
    "--write",
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ...targets,
  ]);
});

test("run-format-check parses explicit formatter modes", () => {
  assert.deepEqual(formatCheckScript.parseFormatArgs(["--write", "src"]), {
    mode: "write",
    targets: ["src"],
  });
  assert.deepEqual(formatCheckScript.parseFormatArgs(["--check", "tests"]), {
    mode: "check",
    targets: ["tests"],
  });
  assert.deepEqual(formatCheckScript.parseFormatArgs(["src"]), {
    mode: "check",
    targets: ["src"],
  });
});
