import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const executionSource = readFileSync(
  path.join(rootDir, "src/core/rin-daemon/cron-execution.ts"),
  "utf8",
);
const schedulerSource = readFileSync(
  path.join(rootDir, "src/core/rin-daemon/cron.ts"),
  "utf8",
);

test("the legacy cron executor owns shell tasks only", () => {
  assert.doesNotMatch(
    executionSource,
    /export async function executeCronTask\b/,
  );
  assert.match(executionSource, /export async function executeCronShellTask\b/);
  assert.match(schedulerSource, /executeCronShellTask\(/);
  assert.doesNotMatch(schedulerSource, /executeCronTask\(/);
});
