import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-versions-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.RIN_TEST_VERSIONS_ROOT;
const versions = await import(pathToFileURL(path.resolve("dist/core/rin/versions.js")).href);
const paths = await import(pathToFileURL(path.resolve("dist/core/rin-install/paths.js")).href);
function parsed(installDir, command = "versions") {
  return {
    command,
    targetUser: os.userInfo().username,
    targetName: "",
    installDir,
    passthrough: [],
    explicitUser: false,
    explicitTarget: false,
    hasSavedInstall: false,
    releaseChannel: "stable",
    releaseBranch: "",
    releaseVersion: "",
    explicitReleaseChannel: false,
    updateAssumeYes: false,
  };
}
const logs = [];
const originalLog = console.log;
console.log = (message) => logs.push(String(message));
try {
  const emptyInstall = path.join(root, "empty");
  versions.runVersions(parsed(emptyInstall));
  await assert.rejects(
    () => versions.runRollback(parsed(emptyInstall, "rollback")),
    /rin_rollback_no_previous_release/,
  );

  const installDir = path.join(root, "installed");
  const releasesDir = path.join(installDir, "app", "releases");
  await fs.mkdir(releasesDir, { recursive: true });
  const names = ["current", "rollback", "newer-a", "newer-b"];
  for (const [index, name] of names.entries()) {
    const dir = path.join(releasesDir, name);
    await fs.mkdir(dir);
    const at = new Date(
      Date.UTC(2026, 0, name.startsWith("newer-") ? 4 : index + 1),
    );
    await fs.utimes(dir, at, at);
  }
  await fs.symlink(
    path.join(releasesDir, "current"),
    path.join(installDir, "app", "current"),
  );
  const manifestPath = paths.installerManifestPath(installDir);
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      currentRelease: {
        name: "current",
        root: path.join(releasesDir, "current"),
        release: { channel: "stable", version: "2.0.0", ref: "current" },
      },
      previousRelease: {
        name: "rollback",
        root: path.join(releasesDir, "rollback"),
        release: { channel: "stable", version: "1.9.0", ref: "rollback" },
      },
    }),
  );

  versions.runVersions(parsed(installDir));
  const sameTarget = path.join(root, "same-target");
  await fs.mkdir(path.dirname(paths.installerManifestPath(sameTarget)), { recursive: true });
  await fs.mkdir(path.join(sameTarget, "app", "releases", "same"), { recursive: true });
  await fs.symlink(
    path.join(sameTarget, "app", "releases", "same"),
    path.join(sameTarget, "app", "current"),
  );
  await fs.writeFile(
    paths.installerManifestPath(sameTarget),
    JSON.stringify({ previousRelease: { name: "same" } }),
  );
  await assert.rejects(
    () => versions.runRollback(parsed(sameTarget, "rollback")),
    /rin_rollback_target_is_current:same/,
  );

  await versions.runRollback(parsed(installDir, "rollback"));
  assert.equal(
    await fs.realpath(path.join(installDir, "app", "current")),
    path.join(releasesDir, "rollback"),
  );
  const remaining = (await fs.readdir(releasesDir)).sort();
  assert.equal(remaining.length, 3);
  assert.equal(remaining.includes("rollback"), true);
  const updated = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(updated.currentRelease.name, "rollback");
  assert.equal(updated.previousRelease.name, "current");
} finally {
  console.log = originalLog;
}
const restarts = (await fs.readFile(process.env.RIN_TEST_VERSIONS_RESTART_LOG, "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
assert.equal(restarts.length, 1);
assert.equal(restarts[0].installDir, path.join(root, "installed"));
assert.match(logs[0], /No installed Rin runtime versions found/);
assert.match(logs.find((line) => line.startsWith("Installed Rin runtime versions")), /installed/);
assert.equal(logs.some((line) => line === "* current (current)"), true);
assert.equal(logs.some((line) => /switched current -> rollback/.test(line)), true);
assert.equal(logs.some((line) => /pruned old releases = 1/.test(line)), true);
console.log(JSON.stringify({ logs, restarts }));
`;

test("versions and rollback own listing, switch, pruning, manifest, and restart handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-versions-owner-"));
  const agentDir = path.join(root, "home", ".rin");
  await fs.mkdir(agentDir, { recursive: true });
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        env: {
          ...process.env,
          RIN_TEST_VERSIONS_ROOT: root,
          RIN_TEST_VERSIONS_HOME: path.join(root, "home"),
          RIN_DIR: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
          RIN_TEST_VERSIONS_RESTART_LOG: path.join(root, "restart.jsonl"),
        },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.restarts.length, 1);
    assert.equal(report.logs.length >= 8, true);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
