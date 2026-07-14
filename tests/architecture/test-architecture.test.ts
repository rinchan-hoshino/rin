import assert from "node:assert/strict";
import test from "node:test";

import { verifyTestArchitecture } from "../../scripts/test/verify-test-architecture.js";

test("test files, module ownership, and coverage policy stay classified", () => {
  const result = verifyTestArchitecture();

  assert.ok(result.tests > 0);
  assert.ok(result.unitModules > 0);
  assert.ok(result.regressionFiles > 0);
  assert.ok(result.characterizationFiles > result.regressionFiles);
  assert.ok(result.coverageModules >= result.unitModules);
});
