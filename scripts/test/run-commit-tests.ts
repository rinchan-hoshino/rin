import { mapWithConcurrency, resolveTestConcurrency } from "./parallel.js";
import { runTestSuites, type TestSuite } from "./run-test-suite.js";

const suites: TestSuite[] = [
  "architecture",
  "unit",
  "acceptance",
  "property",
  "regression",
  "integration",
  "system",
  "qa",
  "torture",
];

const suiteConcurrency = resolveTestConcurrency(
  process.env.RIN_TEST_SUITE_CONCURRENCY,
  3,
  "suite",
);
const statuses = await mapWithConcurrency(suites, suiteConcurrency, (suite) =>
  runTestSuites([suite]),
);
const failedSuite = suites.find((_, index) => statuses[index] !== 0);
if (failedSuite) throw new Error(`commit_test_suite_failed:${failedSuite}`);
