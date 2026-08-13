import { mapWithConcurrency } from "./parallel.js";
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
  "characterization",
];

const statuses = await mapWithConcurrency(suites, 3, (suite) =>
  runTestSuites([suite]),
);
const failedSuite = suites.find((_, index) => statuses[index] !== 0);
if (failedSuite) throw new Error(`commit_test_suite_failed:${failedSuite}`);
