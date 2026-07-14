import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const args = process.argv.slice(2);
const concurrencyArg = args.find((value) => value.startsWith("--concurrency="));
const concurrency = concurrencyArg?.slice("--concurrency=".length) || "4";
const files = args.filter((value) => value !== concurrencyArg);
if (files.length === 0) throw new Error("test_files_empty");
for (const file of files) {
  if (!file.startsWith("tests/") || !file.endsWith(".test.ts")) {
    throw new Error(`invalid_test_file:${file}`);
  }
}

const sandbox = createTestProcessEnvironment("selected-tests");
try {
  const invocation = networkIsolatedNodeInvocation(
    [
      "--import",
      "tsx",
      "scripts/test/run-node-tests.ts",
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      `--test-concurrency=${concurrency}`,
      ...files,
    ],
    sandbox.env,
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: rootDir,
    env: invocation.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  sandbox.cleanup();
}
