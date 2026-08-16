import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readQualityWorkflow() {
  return parseYaml(
    fs.readFileSync(
      path.join(rootDir, ".github/workflows/quality.yml"),
      "utf8",
    ),
  );
}

test("GitHub runs the complete commit gate for pull requests and main", () => {
  const workflow = readQualityWorkflow();

  assert.equal(workflow.name, "Quality");
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);

  const job = workflow.jobs["networkless-commit-gate"];
  assert.equal(job.name, "Networkless commit gate");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);
  assert.deepEqual(job.env, {
    RIN_TEST_SUITE_CONCURRENCY: "1",
    RIN_TEST_FILE_CONCURRENCY: "2",
  });

  const checkout = job.steps.find(
    (step: Record<string, unknown>) => step.name === "Checkout",
  );
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/);
  assert.equal(checkout.with["persist-credentials"], false);

  const setupNode = job.steps.find(
    (step: Record<string, unknown>) => step.name === "Set up Node",
  );
  assert.match(setupNode.uses, /^actions\/setup-node@[0-9a-f]{40}$/);
  assert.equal(setupNode.with["node-version"], "22.19.0");
  assert.equal(setupNode.with["check-latest"], false);

  const completeGate = job.steps.find(
    (step: Record<string, unknown>) => step.name === "Run complete gate",
  );
  assert.equal(completeGate.run, "npm test");
});
