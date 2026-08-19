import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageOwnerPlans,
  normalizeNode22DynamicImportBranches,
  validateCoveragePolicy,
  verifyOwnedCoverage,
  type CoveragePolicy,
} from "../../scripts/test/coverage-ownership.js";

const thresholds = { lines: 90, functions: 90, branches: 85 } as const;
const sources = [
  "src/app/rin/main.ts",
  "src/core/example.ts",
  "src/core/protocol.ts",
];
const policy: CoveragePolicy = {
  schemaVersion: 4,
  thresholds,
  modules: [
    {
      source: sources[0],
      ownerSuite: "system",
    },
    {
      source: sources[1],
      ownerSuite: "unit",
    },
    {
      source: sources[2],
      ownerSuite: "integration",
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

test("coverage policy rejects duplicate and cross-layer ownership", () => {
  const duplicate = structuredClone(policy) as CoveragePolicy;
  duplicate.modules.push({ ...duplicate.modules[0], ownerSuite: "unit" });
  assert.match(
    validateCoveragePolicy(duplicate, sources, unitCatalog).join("\n"),
    /coverage_source_duplicates:src\/app\/rin\/main\.ts/,
  );

  const invalidOwner = structuredClone(policy) as unknown as {
    modules: Array<Record<string, unknown>>;
  };
  invalidOwner.modules[0].ownerSuite = "migration";
  assert.match(
    validateCoveragePolicy(invalidOwner, sources, unitCatalog).join("\n"),
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

  const legacyPolicy = {
    ...structuredClone(policy),
    productionSourceRef: "historical-ref",
  };
  assert.match(
    validateCoveragePolicy(legacyPolicy, sources, unitCatalog).join("\n"),
    /coverage_policy_fields_invalid/,
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

test("coverage owner plans contain only their own suite tests and modules", () => {
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
  assert.equal(JSON.stringify(plans).includes("regression"), false);

  const passing = {
    lines: { total: 10, covered: 9, pct: 90 },
    functions: { total: 10, covered: 9, pct: 90 },
    branches: { total: 20, covered: 17, pct: 85 },
  };
  for (const plan of plans) {
    const modules = policy.modules.filter(
      (module) => module.ownerSuite === plan.suite,
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
