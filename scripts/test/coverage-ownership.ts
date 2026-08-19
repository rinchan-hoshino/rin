export const COVERAGE_OWNER_SUITES = ["unit", "integration", "system"] as const;

export type CoverageOwnerSuite = (typeof COVERAGE_OWNER_SUITES)[number];
export type CoverageMetricName = "lines" | "functions" | "branches";
export type CoverageThresholds = Record<CoverageMetricName, number>;
export type CoverageModule = {
  source: string;
  ownerSuite: CoverageOwnerSuite;
};
export type CoveragePolicy = {
  schemaVersion: 4;
  thresholds: CoverageThresholds;
  modules: CoverageModule[];
};
export type UnitCatalog = {
  schemaVersion: 2;
  thresholds: CoverageThresholds;
  modules: Array<{ source: string; test: string }>;
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

export function builtPathForSource(source: string) {
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
  if (!hasExactFields(value, ["schemaVersion", "thresholds", "modules"])) {
    errors.push("coverage_policy_fields_invalid");
  }
  if (value.schemaVersion !== 4) errors.push("unsupported_schema:coverage");
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
  const unitOwners: string[] = [];
  for (const rawModule of value.modules) {
    if (!isRecord(rawModule)) {
      errors.push("coverage_module_invalid");
      continue;
    }
    const source =
      typeof rawModule.source === "string" ? rawModule.source : "?";
    if (!hasExactFields(rawModule, ["source", "ownerSuite"])) {
      errors.push(`coverage_module_fields_invalid:${source}`);
    }
    const owner = rawModule.ownerSuite;
    sources.push(source);
    if (!COVERAGE_OWNER_SUITES.includes(owner as CoverageOwnerSuite)) {
      errors.push(`coverage_owner_invalid:${source}:${String(owner)}`);
    } else if (owner === "unit") {
      unitOwners.push(source);
    }
  }

  for (const source of duplicateValues(sources)) {
    errors.push(`coverage_source_duplicates:${source}`);
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
      .filter((module) => module.ownerSuite === suite)
      .map((module) => builtPathForSource(module.source))
      .sort(),
  })).filter((plan) => plan.includes.length > 0);
}

export function normalizeNode22DynamicImportBranches(
  metric: CoverageMetric,
  syntheticUncoveredBranches: number,
  nodeMajor: number,
): CoverageMetric {
  if (nodeMajor !== 22 || syntheticUncoveredBranches === 0) return metric;
  if (
    !Number.isInteger(syntheticUncoveredBranches) ||
    syntheticUncoveredBranches < 0 ||
    metric.total - metric.covered < syntheticUncoveredBranches
  ) {
    throw new Error("node22_dynamic_import_branch_signature_mismatch");
  }
  const total = metric.total - syntheticUncoveredBranches;
  const pct =
    total > 0 ? Math.floor((metric.covered / total) * 10_000) / 100 : 100;
  return { total, covered: metric.covered, pct };
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
    const built = builtPathForSource(module.source);
    if (module.ownerSuite !== plan.suite) {
      failures.push(
        `coverage_owner_plan_mismatch:${built}:${module.ownerSuite}:${plan.suite}`,
      );
      continue;
    }
    if (!plannedIncludes.has(built)) {
      failures.push(`coverage_owner_plan_missing:${plan.suite}:${built}`);
      continue;
    }
    const actual = summary[built];
    if (!actual) {
      failures.push(`${built} coverage summary missing`);
      continue;
    }
    for (const name of metricNames) {
      const pct = actual[name]?.pct ?? 0;
      if (pct + 0.005 < thresholds[name]) {
        failures.push(
          `${built} ${name} ${pct.toFixed(2)}% < ${thresholds[name].toFixed(2)}% (strict ${module.ownerSuite} threshold)`,
        );
      }
    }
  }
  return failures;
}
