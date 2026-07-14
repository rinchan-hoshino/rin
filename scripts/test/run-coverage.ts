import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { networkIsolatedNodeInvocation } from "./network-isolated-process.js";
import { findTestFiles, TEST_SUITES } from "./run-test-suite.js";
import { createTestProcessEnvironment } from "./test-process-environment.js";
import { verifyTestArchitecture } from "./verify-test-architecture.js";

type MetricName = "lines" | "functions" | "branches";
type Metric = { total: number; covered: number; pct: number };
type SummaryEntry = Record<MetricName, Metric>;
type CoveragePolicy = {
  target: Record<MetricName, number>;
  modules: Array<{
    source: string;
    built: string;
    status: "strict" | "ratchet";
    baseline: Record<MetricName, Metric>;
  }>;
};
type UnitCatalog = {
  thresholds: Record<MetricName, number>;
  modules: Array<{ source: string; test: string; built: string }>;
};

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

function verifyRatchetMetric(
  failures: string[],
  built: string,
  name: MetricName,
  actual: Metric,
  baseline: Metric,
) {
  if (
    name !== "branches" ||
    actual.total === baseline.total ||
    actual.pct + 0.005 >= baseline.pct
  ) {
    verifyMetric(
      failures,
      built,
      name,
      actual,
      baseline.pct,
      "coverage ratchet",
    );
    return;
  }
  const percentageDrop = baseline.pct - actual.pct;
  const boundedAddedDiscovery =
    actual.covered > baseline.covered && percentageDrop <= 2.5;
  const totalDrop = baseline.total - actual.total;
  const coveredDrop = baseline.covered - actual.covered;
  const boundedReducedDiscovery =
    totalDrop > 0 &&
    totalDrop <= 10 &&
    coveredDrop >= 0 &&
    coveredDrop <= totalDrop &&
    percentageDrop <= 0.05;
  if (!boundedAddedDiscovery && !boundedReducedDiscovery) {
    failures.push(
      `${built} ${name} ${actual.covered}/${actual.total} (${actual.pct.toFixed(2)}%) < baseline ${baseline.covered}/${baseline.total} (${baseline.pct.toFixed(2)}%) (coverage ratchet)`,
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

function runCombinedCoverage() {
  const policy = readJson<CoveragePolicy>("tests/coverage-policy.json");
  const summary = runCoverage({
    name: "combined",
    tests: findTestFiles(TEST_SUITES),
    includes: ["dist/**/*.js"],
    concurrency: 2,
  });
  const failures: string[] = [];

  for (const module of policy.modules) {
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
      if (module.status === "strict") {
        verifyMetric(
          failures,
          module.built,
          name,
          actual[name],
          policy.target[name],
          "strict target",
        );
      } else {
        verifyRatchetMetric(
          failures,
          module.built,
          name,
          actual[name],
          module.baseline[name],
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`combined_coverage_failed:\n${failures.join("\n")}`);
  }
  const strictCount = policy.modules.filter(
    (entry) => entry.status === "strict",
  ).length;
  console.log(
    `Combined coverage: ${strictCount} strict modules and ${policy.modules.length - strictCount} ratcheted modules passed.`,
  );
}

verifyTestArchitecture();
const unitOnly = process.argv.includes("--unit");
if (unitOnly) runUnitCoverage();
else runCombinedCoverage();
