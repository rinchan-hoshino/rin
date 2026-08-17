import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as release from "../../dist/core/rin-lib/release.js";

const manifest: release.ReleaseManifest = {
  packageName: "@owner/rin",
  repoUrl: "git@github.com:owner/rin.git",
  bootstrapBranch: "bootstrap-v2",
  train: { nightlyBranch: "nightly-train" },
  stable: {
    version: "1.2.3",
    archiveUrl: "https://cdn.example/stable.tgz",
    ref: "stable-ref",
    assets: { "linux-x64": { bundleUrl: "https://cdn.example/linux.tgz" } },
    versions: {
      "1.2.2": {
        archiveUrl: "https://cdn.example/1.2.2.tgz",
        ref: "v1.2.2",
        assets: { "linux-arm64": { archiveUrl: "arm64.tgz" } },
      },
    },
  },
  beta: {
    version: "1.3.0-beta.2",
    ref: "beta-ref",
    defaultBranch: "beta-main",
    assets: { "linux-x64": { archiveUrl: "beta-linux.tgz" } },
    branches: {
      experiment: { version: "1.4.0-beta.1", archiveUrl: "experiment.tgz" },
    },
    versions: {
      "1.3.0-beta.1": { branch: "beta-old", archiveUrl: "beta-old.tgz" },
    },
  },
  nightly: {
    version: "1.4.0-nightly.7",
    branch: "nightly-main",
    assets: { "linux-x64": { bundleUrl: "nightly-linux.tgz" } },
  },
  git: { defaultBranch: "develop", repoUrl: "https://github.com/owner/fork" },
};

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-release-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("release URL and platform helpers normalize supported inputs", () => {
  assert.equal(release.releasePlatformKey("linux", "amd64"), "linux-x64");
  assert.equal(release.releasePlatformKey("linux", "x64"), "linux-x64");
  assert.equal(release.releasePlatformKey("darwin", "aarch64"), "darwin-arm64");
  assert.equal(release.releasePlatformKey("darwin", "arm64"), "darwin-arm64");
  assert.equal(
    release.releasePlatformKey("freebsd", "riscv64"),
    "freebsd-riscv64",
  );
  assert.equal(
    release.buildGitHubRefArchiveUrl(
      "git@github.com:owner/rin.git",
      "feature/a b",
    ),
    "https://codeload.github.com/owner/rin/tar.gz/feature/a%20b",
  );
  assert.equal(
    release.buildGitHubBranchArchiveUrl(
      "https://git.example/owner/rin",
      "main",
    ),
    "https://git.example/owner/rin/archive/refs/heads/main.tar.gz",
  );
  assert.equal(
    release.buildNpmTarballUrl("@owner/rin", "1.2.3"),
    "https://registry.npmjs.org/%40owner%2Frin/-/rin-1.2.3.tgz",
  );
  assert.equal(
    release.platformReleaseAssetUrl({ bundleUrl: " bundle.tgz " }),
    "bundle.tgz",
  );
  assert.equal(
    release.platformReleaseAssetUrl({ archiveUrl: " source.tgz " }),
    "source.tgz",
  );
  assert.equal(release.platformReleaseAssetUrl(null), "");
  assert.deepEqual(
    release.selectPlatformReleaseAsset(
      { assets: manifest.stable?.assets },
      "linux-x64",
    ),
    manifest.stable?.assets?.["linux-x64"],
  );
  assert.equal(release.selectPlatformReleaseAsset(manifest, ""), null);
});

test("release resolver covers stable, beta, nightly, and git selectors", () => {
  const stable = release.resolveReleaseRequest(manifest);
  assert.deepEqual(stable, {
    channel: "stable",
    archiveUrl: "https://cdn.example/stable.tgz",
    version: "1.2.3",
    branch: "stable",
    ref: "stable-ref",
    sourceLabel: "stable 1.2.3",
    assets: manifest.stable?.assets,
  });
  assert.equal(
    release.resolveReleaseRequest(manifest, { version: "1.2.2" }).ref,
    "v1.2.2",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, { channel: "beta" }).version,
    "1.3.0-beta.2",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, {
      channel: "beta",
      branch: "experiment",
    }).archiveUrl,
    "experiment.tgz",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, {
      channel: "beta",
      version: "1.3.0-beta.1",
    }).branch,
    "beta-old",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, { channel: "nightly" }).branch,
    "nightly-main",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, { channel: "git" }).branch,
    "develop",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, {
      channel: "git",
      branch: "topic/one",
    }).sourceLabel,
    "git branch topic/one",
  );
  assert.equal(
    release.resolveReleaseRequest(manifest, {
      channel: "git",
      version: "abcdef1",
    }).sourceLabel,
    "git ref abcdef1",
  );

  assert.throws(
    () => release.resolveReleaseRequest(manifest, { branch: "main" }),
    /rin_stable_branch_not_supported/,
  );
  assert.throws(
    () =>
      release.resolveReleaseRequest(manifest, { branch: "main", version: "1" }),
    /rin_release_branch_and_version_conflict/,
  );
  assert.throws(
    () =>
      release.resolveReleaseRequest(manifest, {
        channel: "nightly",
        version: "one",
      }),
    /rin_nightly_selector_not_supported/,
  );
});

test("release manifests load bundled, fallback, and data URL sources", async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, "release-manifest.json");
    await fs.writeFile(file, JSON.stringify(manifest));
    assert.equal(release.getBundledReleaseManifestPath(root), file);
    assert.deepEqual(release.readBundledReleaseManifest(root), manifest);
    assert.ok(
      release.getBundledReleaseManifestPath().endsWith("release-manifest.json"),
    );
    assert.ok(release.readBundledReleaseManifest().stable?.version);

    const networkManifest = {
      ...manifest,
      repoUrl: "data:application/json,%7B%7D",
      bootstrapBranch: "bootstrap",
    };
    await fs.writeFile(file, JSON.stringify(networkManifest));
    const networkFallback = await release.loadReleaseManifestForNetwork(root);
    assert.ok(networkFallback.stable?.version);

    await fs.writeFile(file, "not json");
    const fallback = release.readBundledReleaseManifest(root);
    assert.equal(fallback.schemaVersion, 2);
    assert.equal(fallback.stable?.version, "0.0.0");
  });

  const encoded = encodeURIComponent(
    JSON.stringify({ stable: { version: "9.9.9" } }),
  );
  const fetched = await release.fetchReleaseManifest(
    "data:application/json,not-json",
    `data:application/json,${encoded}`,
  );
  assert.equal(fetched.stable?.version, "9.9.9");
});

test("installed release metadata normalizes files, git refs, and empty values", async () => {
  assert.equal(release.releaseInfoFromObject(null), undefined);
  const git = release.releaseInfoFromObject({
    channel: "git",
    version: "abcdef1234567890",
    branch: "feature",
    archiveUrl: " source.tgz ",
    installedAt: "2026-01-02T03:04:05.000Z",
  });
  assert.equal(git?.version, "abcdef123456");
  assert.equal(git?.ref, "abcdef1234567890");
  assert.equal(git?.sourceLabel, "git feature");

  const stable = release.releaseInfoFromObject({
    channel: "stable",
    version: "1.2.3",
  });
  assert.equal(stable?.branch, "stable");
  assert.equal(stable?.ref, "1.2.3");

  await withTempDir(async (root) => {
    const file = path.join(root, "release.json");
    await fs.writeFile(
      file,
      `\uFEFF${JSON.stringify({ channel: "beta", version: "2.0.0-beta.1" })}`,
    );
    assert.equal(release.releaseInfoFromFile(file)?.channel, "beta");
    assert.equal(
      release.releaseInfoFromFile(path.join(root, "missing.json")),
      undefined,
    );
    assert.equal(release.releaseInfoFromFile(""), undefined);
  });
});

test("release environment overrides are explicit and reversible", () => {
  const previousBranch = process.env.RIN_BOOTSTRAP_BRANCH;
  const previousRepo = process.env.RIN_INSTALL_REPO_URL;
  try {
    process.env.RIN_BOOTSTRAP_BRANCH = " owner-bootstrap ";
    process.env.RIN_INSTALL_REPO_URL = " https://github.com/owner/override ";
    assert.equal(release.getBootstrapBranch(manifest), "owner-bootstrap");
    assert.equal(
      release.getReleaseRepoUrl(manifest),
      "https://github.com/owner/override",
    );
    assert.equal(release.getReleasePackageName(manifest), "@owner/rin");
  } finally {
    if (previousBranch === undefined) delete process.env.RIN_BOOTSTRAP_BRANCH;
    else process.env.RIN_BOOTSTRAP_BRANCH = previousBranch;
    if (previousRepo === undefined) delete process.env.RIN_INSTALL_REPO_URL;
    else process.env.RIN_INSTALL_REPO_URL = previousRepo;
  }
});
