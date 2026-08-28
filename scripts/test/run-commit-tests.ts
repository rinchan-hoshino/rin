import { mapWithConcurrency } from "./parallel.js";
import { runTestSuites, type TestSuite } from "./run-test-suite.js";

const parallelSuites: TestSuite[] = [
  "architecture",
  "unit",
  "acceptance",
  "property",
  "regression",
  "qa",
  "torture",
];

const initialSuite: TestSuite = "integration";
const initialStatus = await runTestSuites([initialSuite]);
if (initialStatus !== 0) {
  throw new Error(`commit_test_suite_failed:${initialSuite}`);
}

const statuses = await mapWithConcurrency(parallelSuites, 3, (suite) =>
  runTestSuites([suite]),
);
const failedSuite = parallelSuites.find((_, index) => statuses[index] !== 0);
if (failedSuite) throw new Error(`commit_test_suite_failed:${failedSuite}`);

const finalSuite: TestSuite = "system";
const finalStatus = await runTestSuites([finalSuite]);
if (finalStatus !== 0) {
  throw new Error(`commit_test_suite_failed:${finalSuite}`);
}
