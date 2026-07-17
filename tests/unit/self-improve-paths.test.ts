import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const paths = await importBuiltModule<
  Record<string, string | ((root?: string) => string)>
>("dist/core/self-improve/paths.js");

function resolve(name: string, root: string) {
  return (paths[name] as (root?: string) => string)(root);
}

test("self-improve paths stay inside the explicit agent directory", () => {
  const root = path.resolve(path.sep, "tmp", "agent");
  const selfImproveRoot = path.join(root, "self_improve");
  assert.equal(resolve("resolveSelfImproveRoot", root), selfImproveRoot);
  assert.equal(
    resolve("selfImprovePromptsDir", root),
    path.join(selfImproveRoot, "prompts"),
  );
  assert.equal(
    resolve("selfImproveSkillsDir", root),
    path.join(selfImproveRoot, "skills"),
  );
  assert.equal(
    resolve("selfImproveStateDir", root),
    path.join(selfImproveRoot, "state"),
  );
  assert.equal(
    resolve("initStatePath", root),
    path.join(selfImproveRoot, "state", "init-state.json"),
  );
  assert.equal(
    resolve("maintenanceQueuePath", root),
    path.join(selfImproveRoot, "state", "maintenance-queue.json"),
  );
  assert.equal(
    resolve("maintenanceHistoryPath", root),
    path.join(selfImproveRoot, "state", "maintenance-history.jsonl"),
  );
  assert.equal(
    resolve("maintenanceLockPath", root),
    path.join(selfImproveRoot, "state", "maintenance-worker.lock"),
  );
});
