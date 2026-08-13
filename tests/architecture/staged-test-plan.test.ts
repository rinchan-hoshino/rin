import assert from "node:assert/strict";
import test from "node:test";

import { createStagedTestPlan } from "../../scripts/test/staged-test-plan.js";

test("staged test plan maps owned tests and production sources to owner coverage", () => {
  const testPlan = createStagedTestPlan([
    "src/core/json-utils.ts",
    "src/core/chat/main.ts",
    "tests/integration/rin-cli-pi-superset.test.ts",
  ]);

  assert.deepEqual(testPlan, {
    fullGate: false,
    architecture: false,
    unitOwnerTests: ["tests/unit/json-utils.test.ts"],
    nonUnitOwnerSources: [
      "src/core/chat/main.ts",
      "src/core/rin/pi-command-adapter.ts",
    ],
    directTests: [],
  });
});

test("staged test plan runs unowned changed tests directly", () => {
  const testPlan = createStagedTestPlan([
    "tests/architecture/local-ci.test.ts",
  ]);

  assert.equal(testPlan.fullGate, false);
  assert.equal(testPlan.architecture, true);
  assert.deepEqual(testPlan.directTests, [
    "tests/architecture/local-ci.test.ts",
  ]);
});

test("staged test plan fails over to the full gate for test infrastructure", () => {
  for (const file of [
    "scripts/test/run-coverage.ts",
    "tests/unit/catalog.json",
    "tests/non-unit/catalog.json",
    "tests/coverage-policy.json",
    "package-lock.json",
  ]) {
    const testPlan = createStagedTestPlan([file]);
    assert.equal(testPlan.fullGate, true, file);
  }
});
