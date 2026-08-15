import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtPathForSource,
  type CoverageMetric,
  type CoverageMetricName,
  type CoveragePolicy,
  type CoverageSummary,
  type CoverageSummaryEntry,
  type UnitCatalog,
  normalizeNode22DynamicImportBranches,
  verifyOwnedCoverage,
  verifyRatchetMetric,
} from "./coverage-ownership.js";
import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { mapWithConcurrency } from "./parallel.js";
import { requireTestContainer } from "./require-test-container.js";
import { findTestFiles, TEST_SUITES } from "./run-test-suite.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";
import { verifyTestArchitecture } from "./verify-test-architecture.js";

type MetricName = CoverageMetricName;
type Metric = CoverageMetric;
type SummaryEntry = CoverageSummaryEntry;

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const metricNames: MetricName[] = ["lines", "functions", "branches"];

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

const coverageJobs = Math.min(4, os.availableParallelism());

type CoverageRunOptions = {
  name: string;
  tests: string[];
  includes: string[];
  concurrency: number;
  preloads?: string[];
  detailed?: boolean;
};

async function runCoverage(options: CoverageRunOptions) {
  const reportDir = path.join(rootDir, "coverage", options.name);
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });

  const c8 = path.join(rootDir, "node_modules", "c8", "bin", "c8.js");
  const sandbox = createTestProcessEnvironment(
    `coverage-${options.name.replaceAll("/", "-")}`,
  );
  let result: { status: number | null; stdout: string; stderr: string };
  try {
    const invocation = networkIsolatedNodeInvocation(
      [
        c8,
        "--all",
        "--clean",
        "--reporter=text-summary",
        "--reporter=json-summary",
        ...(options.detailed ? ["--reporter=text", "--reporter=json"] : []),
        `--reports-dir=${reportDir}`,
        ...options.includes.flatMap((value) => [`--include=${value}`]),
        process.execPath,
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--import",
        "tsx",
        ...(options.preloads || []).flatMap((value) => [
          "--import",
          path.resolve(rootDir, value),
        ]),
        "--test",
        "--test-reporter=tap",
        `--test-concurrency=${options.concurrency}`,
        ...options.tests,
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
  if (result.status !== 0) {
    throw new Error(`coverage_process_failed:${options.name}:${result.status}`);
  }

  if (options.detailed) {
    const raw = readJson<
      Record<
        string,
        {
          statementMap: Record<string, { start: { line: number } }>;
          s: Record<string, number>;
          branchMap: Record<string, { line: number }>;
          b: Record<string, number[]>;
        }
      >
    >(path.relative(rootDir, path.join(reportDir, "coverage-final.json")));
    for (const [file, coverage] of Object.entries(raw)) {
      const uncoveredLines = Object.entries(coverage.s)
        .filter(([, count]) => count === 0)
        .map(([id]) => coverage.statementMap[id]?.start.line)
        .filter((line): line is number => line !== undefined);
      const uncoveredBranches = Object.entries(coverage.b)
        .filter(([, counts]) => counts.some((count) => count === 0))
        .map(([id]) => coverage.branchMap[id]?.line)
        .filter((line): line is number => line !== undefined);
      console.log(
        `Detailed coverage ${path.relative(rootDir, file)}: uncovered lines ${[...new Set(uncoveredLines)].join(",")}; uncovered branches ${[...new Set(uncoveredBranches)].join(",")}`,
      );
    }
  }

  return readJson<Record<string, SummaryEntry>>(
    path.relative(rootDir, path.join(reportDir, "coverage-summary.json")),
  );
}

function summaryFor(
  summary: Record<string, SummaryEntry>,
  built: string,
): SummaryEntry | undefined {
  return summary[path.join(rootDir, built)];
}

function relativeCoverageSummary(
  summary: Record<string, SummaryEntry>,
): CoverageSummary {
  return Object.fromEntries(
    Object.entries(summary).flatMap(([file, entry]) => {
      if (file === "total") return [];
      const relative = path.isAbsolute(file)
        ? path.relative(rootDir, file)
        : file;
      return [[relative.split(path.sep).join("/"), entry]];
    }),
  );
}

function verifyMetric(
  failures: string[],
  built: string,
  name: MetricName,
  actual: Metric | undefined,
  minimum: number,
  rule: string,
) {
  const pct = actual?.pct ?? 0;
  if (pct + 0.005 < minimum) {
    failures.push(
      `${built} ${name} ${pct.toFixed(2)}% < ${minimum.toFixed(2)}% (${rule})`,
    );
  }
}

async function runUnitCoverage(selectedTest?: string) {
  const catalog = readJson<UnitCatalog>("tests/unit/catalog.json");
  const modules = selectedTest
    ? catalog.modules.filter((module) => module.test === selectedTest)
    : catalog.modules;
  if (modules.length === 0) {
    throw new Error(`unit_coverage_owner_not_found:${selectedTest}`);
  }

  const moduleFailures = await mapWithConcurrency(
    modules,
    selectedTest ? 1 : coverageJobs,
    async (module) => {
      const failures: string[] = [];
      const built = builtPathForSource(module.source);
      if (!fs.existsSync(path.join(rootDir, built))) {
        return [`${built} built module missing`];
      }
      const reportName = `unit/${module.source
        .slice("src/".length)
        .replace(/\.ts$/, "")
        .replaceAll("/", "-")}`;
      const summary = await runCoverage({
        name: reportName,
        tests: [module.test],
        includes: [built],
        concurrency: 1,
        detailed: selectedTest !== undefined,
      });
      const actual = summaryFor(summary, built);
      if (!actual) return [`${built} coverage summary missing`];
      for (const name of metricNames) {
        verifyMetric(
          failures,
          built,
          name,
          actual[name],
          catalog.thresholds[name],
          "strict unit threshold",
        );
      }
      return failures;
    },
  );
  const failures = moduleFailures.flat();

  if (failures.length > 0) {
    throw new Error(`unit_coverage_failed:\n${failures.join("\n")}`);
  }
  console.log(
    `Unit coverage: ${modules.length} modules meet per-file thresholds (${coverageJobs} workers).`,
  );
}

async function runNonUnitOwnerCoverage(
  policy: CoveragePolicy,
  selectedSource?: string,
) {
  type NonUnitEntry = {
    source: string;
    suite: "integration" | "system";
    tests: string[];
    preloads?: string[];
    node22DynamicImportUncoveredBranches?: number;
  };
  const catalog = readJson<{
    thresholds: CoveragePolicy["thresholds"];
    modules: NonUnitEntry[];
  }>("tests/non-unit/catalog.json");
  const strictModules = policy.modules.filter(
    (module) => module.status === "strict" && module.ownerSuite !== "unit",
  );

  const indexedEntries = catalog.modules
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !selectedSource || entry.source === selectedSource);
  if (indexedEntries.length === 0) {
    throw new Error(`non_unit_coverage_owner_not_found:${selectedSource}`);
  }

  const groupedPlans = new Map<
    string,
    { index: number; entries: NonUnitEntry[] }
  >();
  for (const { entry, index } of indexedEntries) {
    const key = selectedSource
      ? String(index)
      : JSON.stringify([entry.suite, entry.tests, entry.preloads ?? []]);
    const existing = groupedPlans.get(key);
    if (existing) existing.entries.push(entry);
    else groupedPlans.set(key, { index, entries: [entry] });
  }
  const plans = [...groupedPlans.values()];
  const planFailures = await mapWithConcurrency(
    plans,
    selectedSource ? 1 : coverageJobs,
    async ({ index, entries }) => {
      const failures: string[] = [];
      const owned = entries.flatMap((entry) => {
        const module = strictModules.find(
          (candidate) =>
            candidate.source === entry.source &&
            candidate.ownerSuite === entry.suite,
        );
        if (!module) {
          failures.push(`non_unit_catalog_owner_mismatch:${entry.source}`);
          return [];
        }
        const built = builtPathForSource(entry.source);
        if (!fs.existsSync(path.join(rootDir, built))) {
          failures.push(`${built} built module missing`);
          return [];
        }
        return [{ entry, module, built }];
      });
      if (owned.length === 0) return failures;

      const first = owned[0]?.entry as NonUnitEntry;
      const plan = {
        suite: first.suite,
        tests: first.tests,
        includes: owned.map(({ built }) => built),
      };
      const summary = relativeCoverageSummary(
        await runCoverage({
          name: `owner/${first.suite}/${index}`,
          tests: first.tests,
          includes: plan.includes,
          concurrency: first.suite === "system" ? 2 : 1,
          preloads: first.preloads,
          detailed: selectedSource !== undefined,
        }),
      );
      for (const { entry, built } of owned) {
        const node22Allowance = entry.node22DynamicImportUncoveredBranches ?? 0;
        if (
          node22Allowance > 0 &&
          Number(process.versions.node.split(".")[0]) === 22
        ) {
          const actual = summary[built];
          if (!actual) {
            failures.push(`${built} coverage summary missing`);
          } else {
            try {
              actual.branches = normalizeNode22DynamicImportBranches(
                actual.branches,
                node22Allowance,
                22,
              );
              console.log(
                `${built}: normalized ${node22Allowance} Node 22 V8 dynamic-import branch artifacts.`,
              );
            } catch (error) {
              failures.push(
                `${built} ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
      failures.push(
        ...verifyOwnedCoverage(
          plan,
          owned.map(({ module }) => module),
          summary,
          catalog.thresholds,
        ),
      );
      return failures;
    },
  );
  const failures = planFailures.flat();
  if (!selectedSource) {
    const catalogSources = new Set(
      catalog.modules.map((entry) => entry.source),
    );
    for (const module of strictModules) {
      if (!catalogSources.has(module.source)) {
        failures.push(`non_unit_catalog_missing:${module.source}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`owner_coverage_failed:\n${failures.join("\n")}`);
  }
  const counts = Object.fromEntries(
    ["integration", "system"].map((suite) => [
      suite,
      policy.modules.filter(
        (module) => module.status === "strict" && module.ownerSuite === suite,
      ).length,
    ]),
  );
  console.log(
    `Non-unit owner coverage: integration=${counts.integration} system=${counts.system} (${plans.length} plans, ${coverageJobs} workers).`,
  );
}

async function runCombinedRatchetCoverage(policy: CoveragePolicy) {
  const behaviorSuites = TEST_SUITES.filter(
    (suite) => suite !== "qa" && suite !== "torture",
  );
  const tests = findTestFiles(behaviorSuites);
  const ratchetCount = policy.modules.filter(
    (entry) => entry.status === "ratchet",
  ).length;
  if (ratchetCount === 0) {
    const unitCatalog = readJson<UnitCatalog>("tests/unit/catalog.json");
    const nonUnitCatalog = readJson<{
      modules: Array<{ tests: string[] }>;
    }>("tests/non-unit/catalog.json");
    const ownerTests = new Set([
      ...unitCatalog.modules.map((entry) => entry.test),
      ...nonUnitCatalog.modules.flatMap((entry) => entry.tests),
    ]);
    const behaviorTests = tests.filter((testFile) => !ownerTests.has(testFile));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/test/run-test-files.ts",
        "--concurrency=2",
        ...behaviorTests,
      ],
      { cwd: rootDir, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`combined_behavior_failed:${result.status ?? "unknown"}`);
    }
    console.log(
      `Combined behavior suite: ${behaviorTests.length} non-owner files, no ratchet modules.`,
    );
    return;
  }
  const summary = await runCoverage({
    name: "combined",
    tests,
    includes: ["dist/**/*.js"],
    concurrency: 2,
  });
  const failures: string[] = [];

  for (const module of policy.modules) {
    if (module.status !== "ratchet") continue;
    const built = builtPathForSource(module.source);
    if (!fs.existsSync(path.join(rootDir, built))) {
      failures.push(`${built} built module missing`);
      continue;
    }
    const actual = summaryFor(summary, built);
    if (!actual) {
      failures.push(`${built} coverage summary missing`);
      continue;
    }
    for (const name of metricNames) {
      const failure = verifyRatchetMetric(
        name,
        actual[name],
        module.baseline[name],
      );
      if (failure) failures.push(`${built} ${failure}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`combined_coverage_failed:\n${failures.join("\n")}`);
  }
  console.log(`Combined behavior suite: ${ratchetCount} ratchets passed.`);
}

requireTestContainer();
verifyTestArchitecture();
const unitOnly = process.argv.includes("--unit");
const nonUnitOnly = process.argv.includes("--non-unit");
const combinedOnly = process.argv.includes("--combined");
const ownerIndex = process.argv.indexOf("--owner-test");
const selectedOwnerTest =
  ownerIndex >= 0 ? process.argv[ownerIndex + 1] : undefined;
const sourceIndex = process.argv.indexOf("--source");
const selectedSource =
  sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
if (ownerIndex >= 0 && !selectedOwnerTest) {
  throw new Error("unit_coverage_owner_test_required");
}
if (sourceIndex >= 0 && !selectedSource) {
  throw new Error("non_unit_coverage_source_required");
}
if (unitOnly) await runUnitCoverage(selectedOwnerTest);
else {
  const policy = readJson<CoveragePolicy>("tests/coverage-policy.json");
  if (nonUnitOnly) await runNonUnitOwnerCoverage(policy, selectedSource);
  else if (combinedOnly) await runCombinedRatchetCoverage(policy);
  else {
    await runUnitCoverage();
    await runNonUnitOwnerCoverage(policy);
    await runCombinedRatchetCoverage(policy);
  }
}
