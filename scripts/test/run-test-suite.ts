import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { resolveTestConcurrency } from "./parallel.js";
import { requireTestContainer } from "./require-test-container.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";

export const TEST_SUITES = [
  "architecture",
  "unit",
  "acceptance",
  "property",
  "qa",
  "torture",
  "regression",
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

export async function runTestSuites(
  suites: readonly TestSuite[],
  options: { concurrency?: number; extraNodeArgs?: string[] } = {},
): Promise<number> {
  requireTestContainer();
  const files = findTestFiles(suites);
  if (files.length === 0)
    throw new Error(`test_suite_empty:${suites.join(",")}`);

  const sandbox = createTestProcessEnvironment(`test-${suites.join("-")}`);
  const testConcurrency =
    options.concurrency ??
    resolveTestConcurrency(
      process.env.RIN_TEST_FILE_CONCURRENCY,
      suites.includes("system") ? 2 : 4,
      "file",
    );
  let result: { status: number | null; stdout: string; stderr: string };
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
        `--test-concurrency=${testConcurrency}`,
        ...(options.extraNodeArgs ?? []),
        ...files,
      ],
      sandbox.env,
    );
    result = await new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: rootDir,
        env: invocation.env,
        stdio: ["inherit", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (status) =>
        resolve({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
  } finally {
    sandbox.cleanup();
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

async function main() {
  const requested = process.argv.slice(2);
  const suites = requested.length > 0 ? requested : TEST_SUITES;
  for (const suite of suites) {
    if (!TEST_SUITES.includes(suite as TestSuite)) {
      throw new Error(`unknown_test_suite:${suite}`);
    }
  }
  process.exitCode = await runTestSuites(suites as TestSuite[]);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
