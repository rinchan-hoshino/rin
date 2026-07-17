import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CoverageMetric,
  type CoverageMetricName,
  type CoveragePolicy,
  type CoverageSummary,
  type CoverageSummaryEntry,
  type UnitCatalog,
  verifyOwnedCoverage,
  verifyRatchetMetric,
} from "./coverage-ownership.js";
import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
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

function runCoverage(options: {
  name: string;
  tests: string[];
  includes: string[];
  concurrency: number;
  preloads?: string[];
}) {
  const reportDir = path.join(rootDir, "coverage", options.name);
  fs.rmSync(reportDir, { recursive: true, force: true });
  fs.mkdirSync(reportDir, { recursive: true });

  const c8 = path.join(rootDir, "node_modules", "c8", "bin", "c8.js");
  const sandbox = createTestProcessEnvironment(
    `coverage-${options.name.replaceAll("/", "-")}`,
  );
  let result: ReturnType<typeof spawnSync>;
  try {
    const invocation = networkIsolatedNodeInvocation(
      [
        c8,
        "--all",
        "--clean",
        "--reporter=text-summary",
        "--reporter=json-summary",
        `--reports-dir=${reportDir}`,
        ...options.includes.flatMap((value) => [`--include=${value}`]),
        process.execPath,
        ...(options.preloads || []).flatMap((value) => [
          "--import",
          path.resolve(rootDir, value),
        ]),
        "--import",
        "tsx",
        "scripts/test/run-node-tests.ts",
        "--import",
        "tsx",
        "--test",
        "--test-reporter=tap",
        `--test-concurrency=${options.concurrency}`,
        ...options.tests,
      ],
      sandbox.env,
    );
    result = spawnSync(invocation.command, invocation.args, {
      cwd: rootDir,
      env: invocation.env,
      stdio: "inherit",
    });
  } finally {
    sandbox.cleanup();
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

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

function runUnitCoverage() {
  const catalog = readJson<UnitCatalog>("tests/unit/catalog.json");
  const failures: string[] = [];

  for (const module of catalog.modules) {
    if (!fs.existsSync(path.join(rootDir, module.built))) {
      failures.push(`${module.built} built module missing`);
      continue;
    }
    const reportName = `unit/${module.source
      .slice("src/".length)
      .replace(/\.ts$/, "")
      .replaceAll("/", "-")}`;
    const summary = runCoverage({
      name: reportName,
      tests: [module.test],
      includes: [module.built],
      concurrency: 1,
    });
    const actual = summaryFor(summary, module.built);
    if (!actual) {
      failures.push(`${module.built} coverage summary missing`);
      continue;
    }
    for (const name of metricNames) {
      verifyMetric(
        failures,
        module.built,
        name,
        actual[name],
        catalog.thresholds[name],
        "strict unit threshold",
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`unit_coverage_failed:\n${failures.join("\n")}`);
  }
  console.log(
    `Unit coverage: ${catalog.modules.length} modules meet per-file thresholds.`,
  );
}

function runNonUnitOwnerCoverage(policy: CoveragePolicy) {
  const catalog = readJson<{
    thresholds: CoveragePolicy["thresholds"];
    modules: Array<{
      source: string;
      built: string;
      suite: "integration" | "system";
      tests: string[];
      preloads?: string[];
    }>;
  }>("tests/non-unit/catalog.json");
  const failures: string[] = [];
  const strictModules = policy.modules.filter(
    (module) => module.status === "strict" && module.ownerSuite !== "unit",
  );

  for (const [index, entry] of catalog.modules.entries()) {
    const module = strictModules.find(
      (candidate) =>
        candidate.source === entry.source &&
        candidate.built === entry.built &&
        candidate.ownerSuite === entry.suite,
    );
    if (!module) {
      failures.push(`non_unit_catalog_owner_mismatch:${entry.source}`);
      continue;
    }
    if (!fs.existsSync(path.join(rootDir, entry.built))) {
      failures.push(`${entry.built} built module missing`);
      continue;
    }
    const plan = {
      suite: entry.suite,
      tests: entry.tests,
      includes: [entry.built],
    };
    const summary = relativeCoverageSummary(
      runCoverage({
        name: `owner/${entry.suite}/${index}`,
        tests: entry.tests,
        includes: [entry.built],
        concurrency: entry.suite === "system" ? 2 : 1,
        preloads: entry.preloads,
      }),
    );
    failures.push(
      ...verifyOwnedCoverage(plan, [module], summary, catalog.thresholds),
    );
  }
  const catalogSources = new Set(catalog.modules.map((entry) => entry.source));
  for (const module of strictModules) {
    if (!catalogSources.has(module.source)) {
      failures.push(`non_unit_catalog_missing:${module.source}`);
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
    `Non-unit owner coverage: integration=${counts.integration} system=${counts.system}.`,
  );
}

function runCombinedRatchetCoverage(policy: CoveragePolicy) {
  const tests = findTestFiles(TEST_SUITES);
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
  const summary = runCoverage({
    name: "combined",
    tests,
    includes: ["dist/**/*.js"],
    concurrency: 2,
  });
  const failures: string[] = [];

  for (const module of policy.modules) {
    if (module.status !== "ratchet") continue;
    if (!fs.existsSync(path.join(rootDir, module.built))) {
      failures.push(`${module.built} built module missing`);
      continue;
    }
    const actual = summaryFor(summary, module.built);
    if (!actual) {
      failures.push(`${module.built} coverage summary missing`);
      continue;
    }
    for (const name of metricNames) {
      const failure = verifyRatchetMetric(
        name,
        actual[name],
        module.baseline[name],
      );
      if (failure) failures.push(`${module.built} ${failure}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`combined_coverage_failed:\n${failures.join("\n")}`);
  }
  console.log(`Combined behavior suite: ${ratchetCount} ratchets passed.`);
}

verifyTestArchitecture();
const unitOnly = process.argv.includes("--unit");
const nonUnitOnly = process.argv.includes("--non-unit");
const combinedOnly = process.argv.includes("--combined");
if (unitOnly) runUnitCoverage();
else {
  const policy = readJson<CoveragePolicy>("tests/coverage-policy.json");
  if (nonUnitOnly) runNonUnitOwnerCoverage(policy);
  else if (combinedOnly) runCombinedRatchetCoverage(policy);
  else {
    runUnitCoverage();
    runNonUnitOwnerCoverage(policy);
    runCombinedRatchetCoverage(policy);
  }
}
