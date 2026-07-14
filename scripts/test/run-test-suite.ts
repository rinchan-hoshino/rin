import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";

export const TEST_SUITES = [
  "architecture",
  "unit",
  "regression",
  "characterization",
  "integration",
  "system",
] as const;

export type TestSuite = (typeof TEST_SUITES)[number];

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function findTestFiles(suites: readonly TestSuite[]): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
      }
    }
  };

  for (const suite of suites) visit(path.join(rootDir, "tests", suite));
  return files.sort();
}

export function runTestSuites(
  suites: readonly TestSuite[],
  options: { concurrency?: number; extraNodeArgs?: string[] } = {},
): number {
  const files = findTestFiles(suites);
  if (files.length === 0)
    throw new Error(`test_suite_empty:${suites.join(",")}`);

  const sandbox = createTestProcessEnvironment(`test-${suites.join("-")}`);
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
        `--test-concurrency=${options.concurrency ?? (suites.includes("system") ? 2 : 4)}`,
        ...(options.extraNodeArgs ?? []),
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
    return result.status ?? 1;
  } finally {
    sandbox.cleanup();
  }
}

function main() {
  const requested = process.argv.slice(2);
  const suites = requested.length > 0 ? requested : TEST_SUITES;
  for (const suite of suites) {
    if (!TEST_SUITES.includes(suite as TestSuite)) {
      throw new Error(`unknown_test_suite:${suite}`);
    }
  }
  process.exitCode = runTestSuites(suites as TestSuite[]);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
