import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const deploymentTargets = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "deployment-targets.js"),
  ).href
);

test("cloud-init handoff is removed after provider success or failure", () => {
  for (const shouldThrow of [false, true]) {
    const removed: string[] = [];
    const cloudInitPath = `/tmp/cloud-init-${shouldThrow}.yaml`;
    const action = () => {
      if (shouldThrow) throw new Error("provider failed");
      return "created";
    };
    const invoke = () =>
      deploymentTargets.withTemporaryCloudInit("demo", action, {
        writeCloudInit: () => cloudInitPath,
        rmSync(filePath, options) {
          assert.deepEqual(options, { force: true });
          removed.push(filePath);
        },
      });

    if (shouldThrow) assert.throws(invoke, /provider failed/);
    else assert.equal(invoke(), "created");
    assert.deepEqual(removed, [cloudInitPath]);
  }
});
