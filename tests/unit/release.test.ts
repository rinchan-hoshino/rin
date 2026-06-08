import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const shared = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "shared.js")).href
);
const release = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "release.js"))
    .href
);

test("resolveParsedArgs marks omitted update channel as inherited", () => {
  const parsed = shared.resolveParsedArgs("update", {}, []);
  assert.equal(parsed.releaseChannel, "stable");
  assert.equal(parsed.releaseBranch, "");
  assert.equal(parsed.releaseVersion, "");
  assert.equal(parsed.explicitReleaseChannel, false);
});

test("readInstalledUpdateReleasePreference inherits installed channel", async () => {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-release-"));
  try {
    await fs.writeFile(
      path.join(installDir, "installer.json"),
      JSON.stringify({
        currentRelease: {
          release: {
            channel: "git",
            branch: "main",
            version: "deadbeef",
          },
        },
      }),
      "utf8",
    );
    assert.deepEqual(shared.readInstalledUpdateReleasePreference(installDir), {
      channel: "git",
      branch: "main",
    });
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("readInstalledUpdateReleasePreference reads cross-user channel with privilege", async () => {
  const installDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-release-xuser-"),
  );
  try {
    const preference = shared.readInstalledUpdateReleasePreference(installDir, {
      targetUser: "rin",
      currentUser: "operator",
      readJson() {
        throw new Error("current_user_reader_must_not_be_used");
      },
      readPrivilegedJson(filePath: string, fallback: any) {
        assert.equal(filePath, path.join(installDir, "installer.json"));
        assert.deepEqual(fallback, {});
        return {
          currentRelease: {
            release: {
              channel: "git",
              branch: "main",
              version: "deadbeef",
            },
          },
        };
      },
    });

    assert.deepEqual(preference, {
      channel: "git",
      branch: "main",
    });
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("readInstalledUpdateReleasePreference requires an installed channel", async () => {
  const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-release-"));
  try {
    assert.throws(
      () => shared.readInstalledUpdateReleasePreference(installDir),
      /rin_update_installed_release_channel_missing/,
    );
  } finally {
    await fs.rm(installDir, { recursive: true, force: true });
  }
});

test("resolveParsedArgs accepts beta, nightly, and git selectors", () => {
  const betaParsed = shared.resolveParsedArgs("update", { beta: true }, [
    "update",
    "--beta",
  ]);
  assert.equal(betaParsed.releaseChannel, "beta");
  assert.equal(betaParsed.releaseBranch, "");
  assert.equal(betaParsed.releaseVersion, "");
  assert.equal(betaParsed.explicitReleaseChannel, true);

  const nightlyParsed = shared.resolveParsedArgs("update", { nightly: true }, [
    "update",
    "--nightly",
  ]);
  assert.equal(nightlyParsed.releaseChannel, "nightly");
  assert.equal(nightlyParsed.releaseBranch, "");
  assert.equal(nightlyParsed.releaseVersion, "");

  const gitBranchParsed = shared.resolveParsedArgs("update", { git: true }, [
    "update",
    "--git",
    "main",
  ]);
  assert.equal(gitBranchParsed.releaseChannel, "git");
  assert.equal(gitBranchParsed.releaseBranch, "main");
  assert.equal(gitBranchParsed.releaseVersion, "");

  const gitRefParsed = shared.resolveParsedArgs("update", { git: true }, [
    "update",
    "--git",
    "deadbeef",
  ]);
  assert.equal(gitRefParsed.releaseChannel, "git");
  assert.equal(gitRefParsed.releaseVersion, "deadbeef");
});

test("resolveParsedArgs rejects conflicting release selectors", () => {
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { beta: true, git: true }, [
        "update",
        "--beta",
        "--git",
      ]),
    /rin_release_channel_conflict/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { stable: true, branch: "release/0.69" },
        ["update", "--stable", "--branch", "release/0.69"],
      ),
    /rin_stable_branch_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { beta: true }, [
        "update",
        "--beta",
        "0.69",
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
  assert.throws(
    () =>
      shared.resolveParsedArgs(
        "update",
        { beta: true, version: "0.69.0-beta.1" },
        ["update", "--beta", "--version", "0.69.0-beta.1"],
      ),
    /rin_beta_selector_not_supported/,
  );
  assert.throws(
    () =>
      shared.resolveParsedArgs("update", { stable: true }, [
        "update",
        "--stable",
        "1.2.3",
      ]),
    /rin_stable_selector_not_supported/,
  );
});

test("resolveReleaseRequest resolves stable beta nightly and git sources", () => {
  const manifest = {
    packageName: "@hoshinorin/rin",
    repoUrl: "https://github.com/rinchan-hoshino/rin",
    train: {
      series: "1.3",
      nightlyBranch: "main",
    },
    stable: {
      version: "1.2.3",
      archiveUrl: "https://example.com/stable-1.2.3.tgz",
      ref: "abc1234",
    },
    beta: {
      version: "1.2.4-beta.20260420",
      archiveUrl: "https://example.com/beta-1.2.4-beta.20260420.tgz",
      ref: "def5678",
      promotionVersion: "1.2.4",
    },
    nightly: {
      version: "1.2.5-nightly.20260420+deadbee",
      archiveUrl: "https://example.com/nightly-1.2.5-nightly.20260420.tgz",
      ref: "deadbeef",
      branch: "main",
    },
    git: {
      defaultBranch: "main",
    },
  };

  assert.deepEqual(
    release.resolveReleaseRequest(manifest, { channel: "stable" }),
    {
      channel: "stable",
      archiveUrl: "https://example.com/stable-1.2.3.tgz",
      version: "1.2.3",
      branch: "stable",
      ref: "abc1234",
      sourceLabel: "stable 1.2.3",
    },
  );

  assert.deepEqual(
    release.resolveReleaseRequest(manifest, { channel: "beta" }),
    {
      channel: "beta",
      archiveUrl: "https://example.com/beta-1.2.4-beta.20260420.tgz",
      version: "1.2.4-beta.20260420",
      branch: "beta",
      ref: "def5678",
      sourceLabel: "beta 1.2.4-beta.20260420",
    },
  );

  assert.deepEqual(
    release.resolveReleaseRequest(manifest, { channel: "nightly" }),
    {
      channel: "nightly",
      archiveUrl: "https://example.com/nightly-1.2.5-nightly.20260420.tgz",
      version: "1.2.5-nightly.20260420+deadbee",
      branch: "main",
      ref: "deadbeef",
      sourceLabel: "nightly 1.2.5-nightly.20260420+deadbee",
    },
  );

  const stableFallback = release.resolveReleaseRequest(
    {
      packageName: "@hoshinorin/rin",
      repoUrl: "https://github.com/rinchan-hoshino/rin",
      stable: { version: "1.2.3" },
      beta: manifest.beta,
      nightly: manifest.nightly,
      git: manifest.git,
    },
    { channel: "stable" },
  );
  assert.equal(
    stableFallback.archiveUrl,
    "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-1.2.3.tgz",
  );

  const gitBranchResolved = release.resolveReleaseRequest(manifest, {
    channel: "git",
  });
  assert.equal(gitBranchResolved.channel, "git");
  assert.equal(gitBranchResolved.ref, "main");
  assert.equal(
    gitBranchResolved.archiveUrl,
    "https://codeload.github.com/rinchan-hoshino/rin/tar.gz/refs/heads/main",
  );

  const gitResolved = release.resolveReleaseRequest(manifest, {
    channel: "git",
    version: "deadbeef",
  });
  assert.equal(gitResolved.channel, "git");
  assert.equal(gitResolved.ref, "deadbeef");
  assert.equal(
    gitResolved.archiveUrl,
    "https://codeload.github.com/rinchan-hoshino/rin/tar.gz/deadbeef",
  );
});

test("readBundledReleaseManifest falls back to bundled defaults", () => {
  const manifest = release.readBundledReleaseManifest(
    path.join(rootDir, ".missing-release-manifest-root"),
  );
  assert.equal(manifest.packageName, "@hoshinorin/rin");
  assert.equal(manifest.bootstrapBranch, "bootstrap");
  assert.equal(manifest.train.series, "0.0");
  assert.equal(manifest.stable.version, "0.0.0");
  assert.equal(manifest.beta.version, "0.1.0-beta.0");
  assert.equal(manifest.nightly.version, "0.1.0-nightly.0");
  assert.equal(
    manifest.stable.archiveUrl,
    "https://registry.npmjs.org/%40hoshinorin%2Frin/-/rin-0.0.0.tgz",
  );
});

test("release helpers keep trimmed env and manifest fallback precedence", () => {
  const env = {
    RIN_BOOTSTRAP_BRANCH: process.env.RIN_BOOTSTRAP_BRANCH,
    RIN_INSTALL_REPO_URL: process.env.RIN_INSTALL_REPO_URL,
  };
  process.env.RIN_BOOTSTRAP_BRANCH = "  ";
  process.env.RIN_INSTALL_REPO_URL = " https://example.com/override/repo.git ";
  try {
    assert.equal(
      release.getBootstrapBranch({ bootstrapBranch: " beta-bootstrap " }),
      "beta-bootstrap",
    );
    assert.equal(
      release.getReleaseRepoUrl({
        repoUrl: " https://example.com/fallback/repo.git ",
      }),
      "https://example.com/override/repo.git",
    );
    assert.equal(
      release.getReleasePackageName({ packageName: " @demo/rin " }),
      "@demo/rin",
    );
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("releaseInfoFromObject normalizes installer bootstrap metadata", () => {
  const info = release.releaseInfoFromObject({
    channel: "nightly",
    version: "1.3.0-nightly.20260420+deadbee",
    branch: "main",
    ref: "deadbeef",
    sourceLabel: "nightly 1.3.0-nightly.20260420+deadbee",
    archiveUrl: "https://example.com/nightly-1.3.0-nightly.20260420.tgz",
  });
  assert.equal(info.channel, "nightly");
  assert.equal(info.version, "1.3.0-nightly.20260420+deadbee");
  assert.equal(info.branch, "main");
  assert.equal(info.ref, "deadbeef");
  assert.equal(info.sourceLabel, "nightly 1.3.0-nightly.20260420+deadbee");
  assert.equal(
    info.archiveUrl,
    "https://example.com/nightly-1.3.0-nightly.20260420.tgz",
  );
  assert.match(String(info.installedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
});
