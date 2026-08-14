import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-installer-core-owner-fixture.ts",
);
const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.RIN_TEST_INSTALLER_ROOT;
const main = await import(pathToFileURL(path.resolve("dist/core/rin-install/main.js")).href);
const scenario = globalThis.__rinInstallerOwnerScenario;
const events = globalThis.__rinInstallerOwnerEvents;
const run = async (next, argv) => {
  Object.assign(scenario, next);
  return await main.startInstaller(argv);
};

const planFile = path.join(root, "plan.json");
const resultFile = path.join(root, "result.json");
fs.writeFileSync(planFile, JSON.stringify({ owner: true }));
await run({}, ["--apply-plan-file", planFile, "--apply-result-file=" + resultFile]);
assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).kind, "install");
fs.writeFileSync(planFile, JSON.stringify({ coreUpdate: true }));
await run({}, ["--apply-plan-file=" + planFile, "--apply-result-file", resultFile]);
assert.equal(JSON.parse(fs.readFileSync(resultFile, "utf8")).kind, "core");
const errorFile = path.join(root, "apply-error.txt");
fs.writeFileSync(planFile, JSON.stringify({ fail: true }));
await assert.rejects(
  () => run({}, ["--apply-plan-file", planFile, "--apply-error-file", errorFile]),
  (error) => error.message === "owner apply failed" && error.rinApplyPlanErrorHandoffWritten === true,
);
await assert.rejects(
  () => run({}, ["--apply-plan-file", planFile, "--apply-error-file", root]),
  /owner apply failed/,
);

await run({}, ["--quick-run"]);
await assert.rejects(
  () => run({}, ["--update"]),
  /--update/,
);
await run({}, [
  "--update",
  "--target-user", "owner",
  "--install-dir", root,
  "--yes",
  "--preconfirmed",
  "--release-file", "/owner/work/release.json",
]);

for (const target of ["ssh", "container"]) {
  await run({ target, language: "en_US" }, []);
}
await run({ target: "cancelled" }, []);

const existingDir = path.join(root, "existing-install");
fs.mkdirSync(existingDir);
fs.writeFileSync(path.join(existingDir, "one"), "1");
await run({
  target: "local", targetUser: "owner", installDir: existingDir,
  confirm: false, ownership: { ownerMatches: true, targetUid: 1000, writable: true },
}, []);

Object.assign(scenario, {
  target: "local", targetUser: "other", installDir: path.join(root, "missing-install"),
  confirm: true, elevatedWrite: true,
  ownership: { ownerMatches: false, targetUid: 1001, writable: false },
  setDefaultTarget: true,
});
globalThis.__rinInstallerOwnerResult = () => ({
  written: {
    settingsPath: "/owner/settings", authPath: "/owner/auth", manifestPath: "/owner/manifest",
    locatorManifestPath: "/owner/manifest", launcherPath: "/owner/launcher", rinPath: "/owner/rin",
    rinInstallPath: "/owner/rin-install", targetRinPath: "/owner/rin", targetRinInstallPath: "/owner/rin-install",
  },
  publishedRuntime: { currentLink: "/owner/current", releaseRoot: "/owner/release" },
  installedDocs: {}, installedDocsDir: "", installedService: undefined,
  daemonReady: false, initializationRequired: false,
});
await main.startInstaller(["--language=zh_CN"]);

globalThis.__rinInstallerOwnerResult = () => ({
  written: {
    settingsPath: "/owner/settings", authPath: "/owner/auth", manifestPath: "/owner/manifest",
    locatorManifestPath: "/owner/locator", launcherPath: "/owner/launcher", rinPath: "/owner/rin",
    rinInstallPath: "/owner/rin-install", targetRinPath: "/target/rin", targetRinInstallPath: "/target/rin-install",
  },
  publishedRuntime: { currentLink: "/owner/current", releaseRoot: "/owner/release" },
  installedDocs: { pi: ["/owner/pi"] }, installedDocsDir: "/owner/docs",
  installedService: { servicePath: "/owner/service", kind: "systemd", label: "owner.service" },
  daemonReady: true, initializationRequired: true,
});
await run({
  target: "local", targetUser: "other", installDir: existingDir,
  confirm: true, elevatedWrite: false,
  ownership: { ownerMatches: true, targetUid: -1, writable: true },
}, ["--release-file=/owner/release.json"]);

const names = events.map(([name]) => name);
for (const expected of [
  "quick-run", "install-target", "dir-state", "requirements",
  "finalize-child", "run-command", "register-local",
]) assert.equal(names.includes(expected), true, expected);
assert.equal(names.filter((name) => name === "updater").length, 1);
console.log(JSON.stringify({ events: events.length, updater: names.filter((name) => name === "updater").length }));
`;

test("installer core orchestrates apply, deployment, and local install system paths", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-installer-core-owner-"),
  );
  const sandbox = await createTestSandbox(root);
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
          ...sandbox.env,
          NODE_NO_WARNINGS: "1",
          RIN_TEST_INSTALLER_ROOT: root,
        },
      },
    );
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(summary.events > 40, true);
    assert.equal(summary.updater, 1);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
