import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageOwnerPlans,
  normalizeNode22DynamicImportBranches,
  ratchetBaselineDigest,
  validateCoveragePolicy,
  verifyOwnedCoverage,
  verifyRatchetMetric,
  type CoveragePolicy,
} from "../../scripts/test/coverage-ownership.js";

const thresholds = { lines: 90, functions: 90, branches: 85 } as const;
const sources = [
  "src/app/rin/main.ts",
  "src/core/example.ts",
  "src/core/protocol.ts",
];
const policy: CoveragePolicy = {
  schemaVersion: 3,
  productionSourceRef: "fa644064",
  baselineHarnessVersion: 3,
  baselineCommand: "npm run test:coverage",
  thresholds,
  modules: [
    {
      source: sources[0],
      ownerSuite: "system",
      status: "strict",
    },
    {
      source: sources[1],
      ownerSuite: "unit",
      status: "strict",
    },
    {
      source: sources[2],
      ownerSuite: "integration",
      status: "strict",
    },
  ],
};

const unitCatalog = {
  schemaVersion: 2,
  thresholds,
  modules: [
    {
      source: "src/core/example.ts",
      test: "tests/unit/example.test.ts",
    },
  ],
};

test("coverage policy gives every production module one rightful owner suite", () => {
  assert.deepEqual(validateCoveragePolicy(policy, sources, unitCatalog), []);
});

test("coverage policy rejects duplicate, transitional, and cross-layer ownership", () => {
  const duplicate = structuredClone(policy) as CoveragePolicy;
  duplicate.modules.push({ ...duplicate.modules[0], ownerSuite: "unit" });
  assert.match(
    validateCoveragePolicy(duplicate, sources, unitCatalog).join("\n"),
    /coverage_source_duplicates:src\/app\/rin\/main\.ts/,
  );

  const transitional = structuredClone(policy) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  transitional.modules[0].ownerSuite = "migration";
  assert.match(
    validateCoveragePolicy(transitional, sources, unitCatalog).join("\n"),
    /coverage_owner_invalid:src\/app\/rin\/main\.ts:migration/,
  );

  const wrongUnitOwner = structuredClone(policy) as CoveragePolicy;
  wrongUnitOwner.modules[1].ownerSuite = "integration";
  assert.match(
    validateCoveragePolicy(wrongUnitOwner, sources, unitCatalog).join("\n"),
    /unit_coverage_owner_mismatch/,
  );
});

test("coverage policy rejects legacy fields and an incomplete source inventory", () => {
  const legacy = structuredClone(policy) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  legacy.modules[0].built = "dist/app/rin/main.js";
  assert.match(
    validateCoveragePolicy(legacy, sources, unitCatalog).join("\n"),
    /coverage_module_fields_invalid:src\/app\/rin\/main\.ts/,
  );

  assert.match(
    validateCoveragePolicy(
      policy,
      [...sources, "src/core/missing.ts"],
      unitCatalog,
    ).join("\n"),
    /coverage_policy_does_not_match_source_modules/,
  );
});

test("ratchet ownership is recorded but cannot enter strict owner coverage", () => {
  const transitional = structuredClone(policy) as CoveragePolicy;
  transitional.modules[1] = {
    ...transitional.modules[1],
    status: "ratchet",
    baseline: {
      lines: { total: 10, covered: 5, pct: 50 },
      functions: { total: 2, covered: 1, pct: 50 },
      branches: { total: 4, covered: 2, pct: 50 },
    },
  };

  assert.deepEqual(
    validateCoveragePolicy(transitional, sources, {
      ...unitCatalog,
      modules: [],
    }),
    [],
  );
  assert.equal(
    buildCoverageOwnerPlans(transitional, {
      unit: ["tests/unit/example.test.ts"],
      integration: ["tests/integration/protocol.test.ts"],
      system: ["tests/system/rin.test.ts"],
    }).some((plan) => plan.includes.includes("dist/core/example.js")),
    false,
  );
});

test("coverage owner plans contain only their own suite tests and strict modules", () => {
  const plans = buildCoverageOwnerPlans(policy, {
    unit: ["tests/unit/example.test.ts"],
    integration: ["tests/integration/protocol.test.ts"],
    system: ["tests/system/rin.test.ts"],
  });

  assert.deepEqual(plans, [
    {
      suite: "unit",
      tests: ["tests/unit/example.test.ts"],
      includes: ["dist/core/example.js"],
    },
    {
      suite: "integration",
      tests: ["tests/integration/protocol.test.ts"],
      includes: ["dist/core/protocol.js"],
    },
    {
      suite: "system",
      tests: ["tests/system/rin.test.ts"],
      includes: ["dist/app/rin/main.js"],
    },
  ]);
  assert.equal(JSON.stringify(plans).includes("characterization"), false);
  assert.equal(JSON.stringify(plans).includes("regression"), false);

  const passing = {
    lines: { total: 10, covered: 9, pct: 90 },
    functions: { total: 10, covered: 9, pct: 90 },
    branches: { total: 20, covered: 17, pct: 85 },
  };
  for (const plan of plans) {
    const modules = policy.modules.filter(
      (module) =>
        module.status === "strict" && module.ownerSuite === plan.suite,
    );
    const summary = Object.fromEntries(
      plan.includes.map((built) => [built, passing]),
    );
    assert.deepEqual(
      verifyOwnedCoverage(plan, modules, summary, thresholds),
      [],
      plan.suite,
    );
  }
});

test("ratchet baselines are immutable evidence rather than editable floors", () => {
  const transitional = structuredClone(policy) as CoveragePolicy;
  transitional.modules[2] = {
    ...transitional.modules[2],
    status: "ratchet",
    baseline: {
      lines: { total: 10, covered: 5, pct: 50 },
      functions: { total: 2, covered: 1, pct: 50 },
      branches: { total: 4, covered: 2, pct: 50 },
    },
  };
  const original = ratchetBaselineDigest(transitional);
  if (transitional.modules[2].status !== "ratchet") assert.fail("fixture");
  transitional.modules[2].baseline.lines.covered = 4;
  transitional.modules[2].baseline.lines.pct = 40;
  assert.notEqual(ratchetBaselineDigest(transitional), original);
});

test("Node 22 normalization removes only declared dynamic-import branch artifacts", () => {
  assert.deepEqual(
    normalizeNode22DynamicImportBranches(
      { total: 23, covered: 17, pct: 73.91 },
      6,
      22,
    ),
    { total: 17, covered: 17, pct: 100 },
  );
  assert.deepEqual(
    normalizeNode22DynamicImportBranches(
      { total: 23, covered: 17, pct: 73.91 },
      6,
      26,
    ),
    { total: 23, covered: 17, pct: 73.91 },
  );
  assert.throws(
    () =>
      normalizeNode22DynamicImportBranches(
        { total: 20, covered: 17, pct: 85 },
        6,
        22,
      ),
    /signature_mismatch/,
  );
});

test("ratchet validation permits only bounded V8 branch discovery drift", () => {
  const baseline = { total: 100, covered: 90, pct: 90 };
  assert.equal(
    verifyRatchetMetric(
      "branches",
      { total: 102, covered: 91, pct: 89.21 },
      baseline,
    ),
    undefined,
  );
  assert.match(
    verifyRatchetMetric(
      "branches",
      { total: 102, covered: 90, pct: 88.23 },
      baseline,
    ) ?? "",
    /coverage ratchet/,
  );
  assert.equal(
    verifyRatchetMetric(
      "branches",
      { total: 190, covered: 95, pct: 50 },
      { total: 200, covered: 100, pct: 50 },
    ),
    undefined,
  );
  assert.match(
    verifyRatchetMetric(
      "lines",
      { total: 100, covered: 89, pct: 89 },
      baseline,
    ) ?? "",
    /coverage ratchet/,
  );
});

test("owned coverage fails closed for missing summaries and every threshold", () => {
  const passingMetric = { total: 10, covered: 9, pct: 90 };
  const summary = {
    "dist/core/example.js": {
      lines: passingMetric,
      functions: passingMetric,
      branches: { total: 20, covered: 17, pct: 85 },
    },
  };
  const unitModule = [policy.modules[1]];

  const unitPlan = {
    suite: "unit" as const,
    tests: ["tests/unit/example.test.ts"],
    includes: ["dist/core/example.js"],
  };

  assert.deepEqual(
    verifyOwnedCoverage(unitPlan, unitModule, summary, thresholds),
    [],
  );
  assert.match(
    verifyOwnedCoverage(unitPlan, unitModule, {}, thresholds).join("\n"),
    /dist\/core\/example\.js coverage summary missing/,
  );
  assert.match(
    verifyOwnedCoverage(
      { ...unitPlan, suite: "integration" },
      unitModule,
      summary,
      thresholds,
    ).join("\n"),
    /coverage_owner_plan_mismatch:dist\/core\/example\.js:unit:integration/,
  );

  for (const [metric, pct] of [
    ["lines", 89.99],
    ["functions", 89.99],
    ["branches", 84.99],
  ] as const) {
    const failing = structuredClone(summary);
    failing["dist/core/example.js"][metric].pct = pct;
    assert.match(
      verifyOwnedCoverage(unitPlan, unitModule, failing, thresholds).join("\n"),
      new RegExp(`dist/core/example\\.js ${metric}`),
    );
  }
});
