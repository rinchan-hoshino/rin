import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const shared = await importBuiltModule<
  typeof import("../../src/core/rin/shared-lite.js")
>("dist/core/rin/shared-lite.js");

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-shared-lite-owner-"),
  );
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("shared-lite strips only Rin wrapper arguments", () => {
  assert.deepEqual(
    shared.stripRinWrapperArgs([
      "",
      "--user",
      "demo",
      "--target=desktop",
      "status",
      "--limit",
      "5",
    ]),
    ["status", "--limit", "5"],
  );
  assert.deepEqual(shared.collectTuiPassthroughArgs(["--session=old"]), [
    "--session=old",
  ]);
  assert.deepEqual(
    shared.extractSubcommandArgv(
      ["--user=demo", "update", "--git", "main"],
      "update",
    ),
    ["--git", "main"],
  );
  assert.deepEqual(shared.extractSubcommandArgv(["status"], "update"), [
    "status",
  ]);
  assert.equal(
    shared.hasSubcommandHelpFlag(
      ["--target", "desk", "status", "-h"],
      "status",
    ),
    true,
  );
  assert.equal(shared.hasSubcommandHelpFlag(["status"], "status"), false);
  assert.equal(shared.hasSubcommandHelpFlag(["status"], "update"), false);
});

test("shared-lite reads install records and installed release identity", async () => {
  await withTempDir(async (home) => {
    const metadataPath = path.join(home, ".config", "rin", "install.json");
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        defaultTargetUser: "demo",
        defaultInstallDir: "/srv/rin-demo",
      }),
      "utf8",
    );
    assert.deepEqual(shared.loadInstallConfigForHome(home), {
      defaultTargetUser: "demo",
      defaultInstallDir: "/srv/rin-demo",
    });
    assert.ok(
      shared.installConfigPath().endsWith(path.join("rin", "install.json")),
    );
    assert.equal(typeof shared.loadInstallConfig(), "object");

    const installDir = path.join(home, "runtime");
    const currentRoot = path.join(installDir, "app", "current");
    const releaseRoot = path.join(installDir, "app", "releases", "release-a");
    await fs.mkdir(currentRoot, { recursive: true });
    await fs.mkdir(releaseRoot, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      `\uFEFF${JSON.stringify({ currentRelease: { release: { channel: "stable", version: "1.2.3" } } })}`,
      "utf8",
    );
    assert.equal(shared.readRinPackageVersion(currentRoot), "1.2.3");
    assert.equal(shared.readRinPackageVersion(releaseRoot), "1.2.3");

    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({
        currentRelease: { release: { channel: "git", version: "main" } },
      }),
      "utf8",
    );
    assert.equal(shared.readRinPackageVersion(currentRoot), "unknown");
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({
        currentRelease: { release: { channel: "git", version: "deadbeef" } },
      }),
      "utf8",
    );
    assert.equal(shared.readRinPackageVersion(currentRoot), "deadbeef");
    assert.equal(shared.readRinPackageVersion(home), "unknown");
  });
});

test("shared-lite resolves explicit update release selectors", () => {
  const tui = shared.resolveParsedArgs("", { user: "demo", target: "desk" }, [
    "--user=demo",
    "--target",
    "desk",
    "--session",
    "s1",
  ]);
  assert.equal(tui.targetUser, "demo");
  assert.equal(tui.targetName, "desk");
  assert.equal(tui.explicitUser, true);
  assert.equal(tui.explicitTarget, true);
  assert.deepEqual(tui.passthrough, ["--session", "s1"]);
  assert.equal(tui.releaseChannel, "stable");
  assert.equal(tui.explicitReleaseChannel, false);

  const beta = shared.resolveParsedArgs("update", { beta: true, yes: true }, [
    "update",
    "--beta",
  ]);
  assert.equal(beta.releaseChannel, "beta");
  assert.equal(beta.updateAssumeYes, true);

  const nightly = shared.resolveParsedArgs("update", { nightly: true }, [
    "update",
    "--nightly",
  ]);
  assert.equal(nightly.releaseChannel, "nightly");

  const gitBranch = shared.resolveParsedArgs("update", { git: true }, [
    "update",
    "--git=feature/demo",
  ]);
  assert.equal(gitBranch.releaseBranch, "feature/demo");
  const gitRef = shared.resolveParsedArgs("update", { git: true }, [
    "update",
    "--git",
    "refs/tags/v1.2.3",
  ]);
  assert.equal(gitRef.releaseVersion, "refs/tags/v1.2.3");
  const explicitBranch = shared.resolveParsedArgs(
    "update",
    { git: true, branch: "main" },
    ["update", "--git", "ignored", "--branch", "main"],
  );
  assert.equal(explicitBranch.releaseBranch, "main");
  const explicitVersion = shared.resolveParsedArgs(
    "update",
    { git: true, version: "deadbeef" },
    ["update", "--git", "ignored", "--version", "deadbeef"],
  );
  assert.equal(explicitVersion.releaseVersion, "deadbeef");
});

test("shared-lite rejects ambiguous or unsupported release selectors", () => {
  assert.throws(
    () => shared.resolveParsedArgs("update", { beta: true, git: true }, []),
    /rin_release_channel_conflict/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { git: true, branch: "main", version: "deadbeef" },
        [],
      ),
    /rin_release_branch_and_version_conflict/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { stable: true, branch: "main" }, []),
    /rin_stable_branch_not_supported/,
  );
  assert.throws(
    () => shared.resolveParsedArgs("update", { beta: true, version: "1" }, []),
    /rin_beta_selector_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { nightly: true, branch: "next" }, []),
    /rin_nightly_selector_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { stable: true }, [
        "update",
        "--stable=1.2.3",
      ]),
    /rin_stable_selector_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { beta: true }, [
        "update",
        "--beta",
        "1.2.3",
      ]),
    /rin_beta_selector_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { nightly: true }, [
        "update",
        "--nightly",
        "tomorrow",
      ]),
    /rin_nightly_selector_not_supported/,
  );
});
