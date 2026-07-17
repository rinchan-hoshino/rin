import { createHash } from "node:crypto";

export const COVERAGE_OWNER_SUITES = ["unit", "integration", "system"] as const;

export type CoverageOwnerSuite = (typeof COVERAGE_OWNER_SUITES)[number];
export type CoverageMetricName = "lines" | "functions" | "branches";
export type CoverageThresholds = Record<CoverageMetricName, number>;
type CoverageModuleBase = {
  source: string;
  built: string;
  ownerSuite: CoverageOwnerSuite;
};
export type StrictCoverageModule = CoverageModuleBase & {
  status: "strict";
};
export type RatchetCoverageModule = CoverageModuleBase & {
  status: "ratchet";
  baseline: Record<CoverageMetricName, CoverageMetric>;
};
export type CoverageModule = StrictCoverageModule | RatchetCoverageModule;
export type CoveragePolicy = {
  schemaVersion: 2;
  productionSourceRef: "fa644064";
  baselineHarnessVersion: 3;
  baselineCommand: "npm run test:coverage";
  thresholds: CoverageThresholds;
  modules: CoverageModule[];
};
export type UnitCatalog = {
  thresholds: CoverageThresholds;
  modules: Array<{ source: string; built: string; test: string }>;
};
export type CoverageMetric = { total: number; covered: number; pct: number };
export type CoverageSummaryEntry = Record<CoverageMetricName, CoverageMetric>;
export type CoverageSummary = Record<string, CoverageSummaryEntry>;
export type CoverageOwnerPlan = {
  suite: CoverageOwnerSuite;
  tests: string[];
  includes: string[];
};

const metricNames: CoverageMetricName[] = ["lines", "functions", "branches"];
const requiredThresholds: CoverageThresholds = {
  lines: 90,
  functions: 90,
  branches: 85,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameMembers(actual: string[], expected: string[]) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactFields(value: Record<string, unknown>, fields: string[]) {
  return sameMembers(Object.keys(value), fields);
}

function duplicateValues(values: string[]) {
  return [
    ...new Set(
      values.filter((value, index) => values.indexOf(value) !== index),
    ),
  ];
}

function expectedBuiltPath(source: string) {
  return source.startsWith("src/") && source.endsWith(".ts")
    ? `dist/${source.slice("src/".length).replace(/\.ts$/, ".js")}`
    : "";
}

export function validateCoveragePolicy(
  value: unknown,
  sourceFiles: string[],
  unitCatalog: UnitCatalog,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["coverage_policy_invalid"];
  if (
    !hasExactFields(value, [
      "schemaVersion",
      "productionSourceRef",
      "baselineHarnessVersion",
      "baselineCommand",
      "thresholds",
      "modules",
    ])
  ) {
    errors.push("coverage_policy_fields_invalid");
  }
  if (value.schemaVersion !== 2) errors.push("unsupported_schema:coverage");
  if (
    value.productionSourceRef !== "fa644064" ||
    value.baselineHarnessVersion !== 3 ||
    value.baselineCommand !== "npm run test:coverage"
  ) {
    errors.push("coverage_baseline_provenance_changed");
  }
  if (
    !isRecord(value.thresholds) ||
    JSON.stringify(value.thresholds) !== JSON.stringify(requiredThresholds)
  ) {
    errors.push("coverage_targets_must_remain_90_90_85");
  }
  if (!Array.isArray(value.modules)) {
    errors.push("coverage_modules_invalid");
    return errors;
  }

  const sources: string[] = [];
  const builtPaths: string[] = [];
  const unitOwners: string[] = [];
  for (const rawModule of value.modules) {
    if (!isRecord(rawModule)) {
      errors.push("coverage_module_invalid");
      continue;
    }
    const source =
      typeof rawModule.source === "string" ? rawModule.source : "?";
    const status = rawModule.status;
    const expectedFields =
      status === "ratchet"
        ? ["source", "built", "ownerSuite", "status", "baseline"]
        : ["source", "built", "ownerSuite", "status"];
    if (!hasExactFields(rawModule, expectedFields)) {
      errors.push(`coverage_module_fields_invalid:${source}`);
    }
    if (status !== "strict" && status !== "ratchet") {
      errors.push(`coverage_status_invalid:${source}:${String(status)}`);
    }
    const built = typeof rawModule.built === "string" ? rawModule.built : "";
    const owner = rawModule.ownerSuite;
    sources.push(source);
    builtPaths.push(built);
    if (!COVERAGE_OWNER_SUITES.includes(owner as CoverageOwnerSuite)) {
      errors.push(`coverage_owner_invalid:${source}:${String(owner)}`);
    } else if (owner === "unit" && status === "strict") {
      unitOwners.push(source);
    }
    if (built !== expectedBuiltPath(source)) {
      errors.push(`coverage_built_path_mismatch:${source}`);
    }
    if (status === "ratchet") {
      if (!isRecord(rawModule.baseline)) {
        errors.push(`coverage_baseline_invalid:${source}`);
      } else {
        for (const metric of metricNames) {
          const baseline = rawModule.baseline[metric];
          const total = isRecord(baseline) ? baseline.total : undefined;
          const covered = isRecord(baseline) ? baseline.covered : undefined;
          const pct = isRecord(baseline) ? baseline.pct : undefined;
          const expectedPct =
            typeof total === "number" &&
            typeof covered === "number" &&
            total > 0
              ? Math.floor((covered / total) * 10_000) / 100
              : 100;
          if (
            !Number.isInteger(total) ||
            !Number.isInteger(covered) ||
            typeof pct !== "number" ||
            (total as number) < (covered as number) ||
            (covered as number) < 0 ||
            pct < 0 ||
            pct > 100 ||
            Math.abs(pct - expectedPct) > 0.005
          ) {
            errors.push(`coverage_baseline_invalid:${source}:${metric}`);
          }
        }
      }
    }
  }

  for (const source of duplicateValues(sources)) {
    errors.push(`coverage_source_duplicates:${source}`);
  }
  for (const built of duplicateValues(builtPaths)) {
    errors.push(`coverage_built_duplicates:${built}`);
  }
  if (!sameMembers(sources, sourceFiles)) {
    errors.push("coverage_policy_does_not_match_source_modules");
  }
  if (
    !sameMembers(
      unitOwners,
      unitCatalog.modules.map((entry) => entry.source),
    )
  ) {
    errors.push("unit_coverage_owner_mismatch");
  }
  if (
    JSON.stringify(unitCatalog.thresholds) !==
    JSON.stringify(requiredThresholds)
  ) {
    errors.push("unit_targets_must_remain_90_90_85");
  }
  return errors;
}

export function buildCoverageOwnerPlans(
  policy: CoveragePolicy,
  tests: Record<CoverageOwnerSuite, string[]>,
): CoverageOwnerPlan[] {
  return COVERAGE_OWNER_SUITES.map((suite) => ({
    suite,
    tests: [...tests[suite]].sort(),
    includes: policy.modules
      .filter(
        (module) => module.ownerSuite === suite && module.status === "strict",
      )
      .map((module) => module.built)
      .sort(),
  })).filter((plan) => plan.includes.length > 0);
}

export function ratchetBaselineDigest(policy: CoveragePolicy) {
  const payload = {
    productionSourceRef: policy.productionSourceRef,
    baselineHarnessVersion: policy.baselineHarnessVersion,
    baselineCommand: policy.baselineCommand,
    modules: policy.modules
      .filter((module) => module.status === "ratchet")
      .map(({ source, built, ownerSuite, status, baseline }) => ({
        source,
        built,
        ownerSuite,
        status,
        baseline,
      })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function verifyRatchetMetric(
  name: CoverageMetricName,
  actual: CoverageMetric,
  baseline: CoverageMetric,
): string | undefined {
  if (
    name !== "branches" ||
    actual.total === baseline.total ||
    actual.pct + 0.005 >= baseline.pct
  ) {
    return actual.pct + 0.005 < baseline.pct
      ? `${name} ${actual.pct.toFixed(2)}% < ${baseline.pct.toFixed(2)}% (coverage ratchet)`
      : undefined;
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
  return boundedAddedDiscovery || boundedReducedDiscovery
    ? undefined
    : `${name} ${actual.covered}/${actual.total} (${actual.pct.toFixed(2)}%) < baseline ${baseline.covered}/${baseline.total} (${baseline.pct.toFixed(2)}%) (coverage ratchet)`;
}

export function verifyOwnedCoverage(
  plan: CoverageOwnerPlan,
  modules: CoverageModule[],
  summary: CoverageSummary,
  thresholds: CoverageThresholds,
): string[] {
  const failures: string[] = [];
  const plannedIncludes = new Set(plan.includes);
  for (const module of modules) {
    if (module.ownerSuite !== plan.suite) {
      failures.push(
        `coverage_owner_plan_mismatch:${module.built}:${module.ownerSuite}:${plan.suite}`,
      );
      continue;
    }
    if (!plannedIncludes.has(module.built)) {
      failures.push(
        `coverage_owner_plan_missing:${plan.suite}:${module.built}`,
      );
      continue;
    }
    const actual = summary[module.built];
    if (!actual) {
      failures.push(`${module.built} coverage summary missing`);
      continue;
    }
    for (const name of metricNames) {
      const pct = actual[name]?.pct ?? 0;
      if (pct + 0.005 < thresholds[name]) {
        failures.push(
          `${module.built} ${name} ${pct.toFixed(2)}% < ${thresholds[name].toFixed(2)}% (strict ${module.ownerSuite} threshold)`,
        );
      }
    }
  }
  return failures;
}
