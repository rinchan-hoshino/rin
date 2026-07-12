import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_SUFFIX = ".test.ts";

function collectTestFiles(directory: string, files: string[]) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
      files.push(entryPath);
    }
  }
}

export function discoverTestFiles(rootDir: string, suite: string) {
  const suiteDir = path.join(rootDir, "tests", suite);
  const files: string[] = [];
  if (fs.existsSync(suiteDir)) collectTestFiles(suiteDir, files);
  files.sort();
  if (!files.length) throw new Error(`rin_test_suite_empty:${suite}`);
  return files;
}

export function buildNodeTestArgs(files: string[], concurrency: number) {
  return [
    "--import",
    "tsx",
    "--test",
    `--test-concurrency=${concurrency}`,
    ...files,
  ];
}

function parseArgs(argv: string[]) {
  let suite = "";
  let concurrency = 1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--suite") suite = String(argv[++index] || "").trim();
    else if (arg === "--concurrency") {
      concurrency = Number(argv[++index] || 1);
    } else {
      throw new Error(`rin_test_runner_unknown_argument:${arg}`);
    }
  }
  if (!suite) throw new Error("rin_test_runner_suite_required");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("rin_test_runner_invalid_concurrency");
  }
  return { suite, concurrency };
}

export function runTestSuite(rootDir: string, argv: string[]) {
  const { suite, concurrency } = parseArgs(argv);
  const files = discoverTestFiles(rootDir, suite);
  const result = spawnSync(
    process.execPath,
    buildNodeTestArgs(files, concurrency),
    { cwd: rootDir, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal) return 1;
  return result.status ?? 1;
}

const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (scriptPath === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(scriptPath), "..");
  process.exitCode = runTestSuite(rootDir, process.argv.slice(2));
}
