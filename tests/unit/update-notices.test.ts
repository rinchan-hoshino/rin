import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const notices = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "update-notices.js"),
  ).href
);
const execFileAsync = promisify(execFile);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-notices-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writePackageVersion(dir: string, version: string) {
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ version })}\n`,
    "utf8",
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function withReleaseEnvCleared(fn: () => Promise<void>) {
  const previous = {
    RIN_RELEASE_CHANNEL: process.env.RIN_RELEASE_CHANNEL,
    RIN_RELEASE_VERSION: process.env.RIN_RELEASE_VERSION,
    RIN_RELEASE_BRANCH: process.env.RIN_RELEASE_BRANCH,
    RIN_RELEASE_REF: process.env.RIN_RELEASE_REF,
    RIN_RELEASE_SOURCE_LABEL: process.env.RIN_RELEASE_SOURCE_LABEL,
    RIN_RELEASE_ARCHIVE_URL: process.env.RIN_RELEASE_ARCHIVE_URL,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Rin update notices compare package versions with prerelease precedence", () => {
  assert.ok(notices.comparePackageVersions("1.2.4", "1.2.3") > 0);
  assert.ok(notices.comparePackageVersions("1.2.4", "1.2.4-beta.1") > 0);
  assert.ok(
    notices.comparePackageVersions("1.2.4-beta.10", "1.2.4-beta.2") > 0,
  );
  assert.equal(notices.comparePackageVersions("invalid", "1.2.3"), 0);
});

test("current Rin version prefers installed release metadata outside source-root reads", async () => {
  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    const previousReleaseVersion = process.env.RIN_RELEASE_VERSION;
    try {
      delete process.env.RIN_RELEASE_VERSION;
      process.env.RIN_DIR = dir;
      await fs.writeFile(
        path.join(dir, "installer.json"),
        JSON.stringify({
          currentRelease: { release: { version: "abc123def456" } },
        }),
        "utf8",
      );

      assert.equal(notices.readInstalledRinReleaseVersion(dir), "abc123def456");
      assert.equal(notices.getCurrentRinVersion(), "abc123def456");
      assert.equal(notices.getCurrentRinVersion(rootDir), "0.0.0");
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
      if (previousReleaseVersion === undefined)
        delete process.env.RIN_RELEASE_VERSION;
      else process.env.RIN_RELEASE_VERSION = previousReleaseVersion;
    }
  });
});

test("Rin update check uses Rin release manifest instead of Pi latest-version", async () => {
  const manifest = {
    stable: { version: "1.2.4" },
    beta: { version: "1.3.0-beta.2" },
    nightly: { version: "1.3.0-nightly.20260429" },
  };

  assert.equal(
    await notices.checkForNewRinVersion({
      currentVersion: "1.2.3",
      channel: "stable",
      manifest,
    }),
    "1.2.4",
  );
  assert.equal(
    await notices.checkForNewRinVersion({
      currentVersion: "1.2.4",
      channel: "stable",
      manifest,
    }),
    undefined,
  );
});

test("Rin update check follows installed release channel metadata", async () => {
  await withReleaseEnvCleared(async () => {
    await withTempDir(async (dir) => {
      const sourceRoot = path.join(dir, "src");
      const runtimeDir = path.join(dir, "runtime");
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(runtimeDir, { recursive: true });
      await writePackageVersion(sourceRoot, "0.0.0");
      await fs.writeFile(
        path.join(runtimeDir, "installer.json"),
        `${JSON.stringify({
          currentRelease: {
            release: {
              channel: "beta",
              version: "1.3.0-beta.1",
              branch: "beta",
              ref: "abc123",
              sourceLabel: "beta 1.3.0-beta.1",
            },
          },
        })}\n`,
        "utf8",
      );

      const notice = await notices.checkForRinUpdateNotice({
        sourceRoot,
        runtimeDir,
        manifest: {
          stable: { version: "9.0.0" },
          beta: { version: "1.3.0-beta.2" },
          nightly: { version: "1.3.0-nightly.20260429" },
        },
      });

      assert.equal(notice?.channel, "beta");
      assert.equal(notice?.version, "1.3.0-beta.2");
      assert.equal(notice?.command, "rin update --beta");
      assert.equal(
        await notices.checkForNewRinVersion({
          sourceRoot,
          runtimeDir,
          manifest: {
            stable: { version: "9.0.0" },
            beta: { version: "1.3.0-beta.2" },
          },
        }),
        "1.3.0-beta.2",
      );
    });
  });
});

test("Rin git installs do not receive stable package update notices", async () => {
  await withReleaseEnvCleared(async () => {
    await withTempDir(async (dir) => {
      const sourceRoot = path.join(dir, "src");
      const runtimeDir = path.join(dir, "runtime");
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(runtimeDir, { recursive: true });
      await writePackageVersion(sourceRoot, "0.0.0");
      await fs.writeFile(
        path.join(runtimeDir, "installer.json"),
        `${JSON.stringify({
          release: {
            channel: "git",
            version: "dc6b3a586e35",
            branch: "main",
            ref: "dc6b3a586e35f078ab26d861624f91e465004648",
            sourceLabel: "git branch main @ dc6b3a586e35",
          },
        })}\n`,
        "utf8",
      );

      assert.equal(
        await notices.checkForRinUpdateNotice({
          sourceRoot,
          runtimeDir,
          manifest: { stable: { version: "9.0.0" } },
        }),
        undefined,
      );
    });
  });
});

test("Rin update notice follows the installed release channel", async () => {
  const stableNewerManifest = {
    stable: { version: "9.0.0" },
    beta: { version: "1.3.0-beta.2" },
    nightly: { version: "1.3.0-nightly.2" },
  };

  const betaNotice = await notices.checkForRinUpdateNotice({
    currentRelease: {
      channel: "beta",
      version: "1.3.0-beta.1",
      branch: "beta",
      ref: "beta-ref",
      sourceLabel: "beta 1.3.0-beta.1",
      archiveUrl: "",
    },
    manifest: stableNewerManifest,
  });
  assert.equal(betaNotice?.channel, "beta");
  assert.equal(betaNotice?.version, "1.3.0-beta.2");
  assert.equal(betaNotice?.command, "rin update --beta");

  const staleNightlyManifestNotice = await notices.checkForRinUpdateNotice({
    currentRelease: {
      channel: "stable",
      version: "1.3.0-nightly.1",
      branch: "main",
      ref: "nightly-ref",
      sourceLabel: "nightly 1.3.0-nightly.1",
      archiveUrl: "",
    },
    manifest: stableNewerManifest,
  });
  assert.equal(staleNightlyManifestNotice?.channel, "nightly");
  assert.equal(staleNightlyManifestNotice?.version, "1.3.0-nightly.2");
  assert.equal(staleNightlyManifestNotice?.command, "rin update --nightly");
});

test("Rin update notice reads installed release metadata", async () => {
  await withReleaseEnvCleared(async () => {
    await withTempDir(async (dir) => {
      await writePackageVersion(dir, "0.0.0");
      await fs.writeFile(
        path.join(dir, "installer.json"),
        `${JSON.stringify({
          currentRelease: {
            release: {
              channel: "nightly",
              version: "1.3.0-nightly.1",
              branch: "main",
              ref: "nightly-ref",
              sourceLabel: "nightly 1.3.0-nightly.1",
              archiveUrl: "",
            },
          },
        })}\n`,
        "utf8",
      );

      assert.deepEqual(notices.readInstalledRinReleaseInfo(dir), {
        channel: "nightly",
        version: "1.3.0-nightly.1",
        branch: "main",
        ref: "nightly-ref",
        sourceLabel: "nightly 1.3.0-nightly.1",
        archiveUrl: "",
      });
      const notice = await notices.checkForRinUpdateNotice({
        runtimeDir: dir,
        manifest: {
          stable: { version: "9.0.0" },
          nightly: { version: "1.3.0-nightly.2" },
        },
      });
      assert.equal(notice?.channel, "nightly");
      assert.equal(notice?.version, "1.3.0-nightly.2");
    });
  });
});

test("Rin git update notice follows the installed git branch", async () => {
  await withTempDir(async (dir) => {
    const repoDir = path.join(dir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ["init", "-b", "main"]);
    await runGit(repoDir, ["config", "user.email", "rin@example.invalid"]);
    await runGit(repoDir, ["config", "user.name", "Rin Test"]);
    await fs.writeFile(path.join(repoDir, "file.txt"), "one\n", "utf8");
    await runGit(repoDir, ["add", "file.txt"]);
    await runGit(repoDir, ["commit", "-m", "first"]);
    const first = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
    ).stdout.trim();
    await fs.writeFile(path.join(repoDir, "file.txt"), "two\n", "utf8");
    await runGit(repoDir, ["commit", "-am", "second"]);
    const second = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir })
    ).stdout.trim();

    const notice = await notices.checkForRinUpdateNotice({
      currentRelease: {
        channel: "git",
        version: first.slice(0, 12),
        branch: "main",
        ref: first,
        sourceLabel: `git branch main @ ${first.slice(0, 12)}`,
        archiveUrl: "",
      },
      manifest: { git: { repoUrl: repoDir, defaultBranch: "main" } },
    });
    assert.equal(notice?.channel, "git");
    assert.equal(notice?.version, second.slice(0, 12));
    assert.equal(notice?.command, "rin update --git main");
  });
});

test("Rin git update check returns before the git probe completes", async () => {
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const gitPath = path.join(binDir, "git");
    await fs.writeFile(
      gitPath,
      [
        "#!/bin/sh",
        "sleep 0.2",
        "printf '1234567890abcdef1234567890abcdef12345678\\trefs/heads/main\\n'",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(gitPath, 0o755);

    const previousPath = process.env.PATH;
    const previousSkip = process.env.PI_SKIP_VERSION_CHECK;
    const previousPiOffline = process.env.PI_OFFLINE;
    const previousRinOffline = process.env.RIN_OFFLINE;
    try {
      process.env.PATH = `${binDir}${path.delimiter}${previousPath || ""}`;
      delete process.env.PI_SKIP_VERSION_CHECK;
      delete process.env.PI_OFFLINE;
      delete process.env.RIN_OFFLINE;

      const startedAt = Date.now();
      const noticePromise = notices.checkForRinUpdateNotice({
        currentRelease: {
          channel: "git",
          version: "000000000000",
          branch: "main",
          ref: "0000000000000000000000000000000000000000",
          sourceLabel: "git branch main @ 000000000000",
          archiveUrl: "",
        },
        manifest: { git: { repoUrl: "ignored", defaultBranch: "main" } },
      });
      const elapsedMs = Date.now() - startedAt;

      assert.ok(
        elapsedMs < 100,
        `git update check blocked startup for ${elapsedMs}ms`,
      );
      const notice = await noticePromise;
      assert.equal(notice?.version, "1234567890ab");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = previousSkip;
      if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousPiOffline;
      if (previousRinOffline === undefined) delete process.env.RIN_OFFLINE;
      else process.env.RIN_OFFLINE = previousRinOffline;
    }
  });
});

test("Rin update check preserves Pi version-check skip env", async () => {
  const previous = process.env.PI_SKIP_VERSION_CHECK;
  try {
    process.env.PI_SKIP_VERSION_CHECK = "1";
    assert.equal(
      await notices.checkForNewRinVersion({
        currentVersion: "1.2.3",
        channel: "stable",
        manifest: { stable: { version: "1.2.4" } },
      }),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
    else process.env.PI_SKIP_VERSION_CHECK = previous;
  }
});

test("Rin changelog entries read docs/release without settings state", async () => {
  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    try {
      process.env.RIN_DIR = dir;
      const changelogPath = path.join(dir, "docs", "release", "CHANGELOG.md");
      await fs.mkdir(path.dirname(changelogPath), { recursive: true });
      await fs.writeFile(
        changelogPath,
        ["# Rin Changelog", "", "## 1.1.0", "", "- Rin feature", ""].join("\n"),
        "utf8",
      );

      assert.deepEqual(notices.readRinChangelogEntries(), [
        { heading: "1.1.0", content: "## 1.1.0\n- Rin feature" },
      ]);
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }
  });
});

test("Rin changelog entry comparison handles prerelease and build metadata versions", () => {
  const entries = [
    { heading: "[1.1.0-beta.20260518] - old", content: "old beta" },
    { heading: "1.1.0-beta.20260519+abc1234", content: "new beta" },
    { heading: "1.1.0-nightly.20260519+def5678", content: "nightly" },
    { heading: "1.1.0", content: "stable" },
    { heading: "not-a-version", content: "ignored" },
  ];

  assert.deepEqual(
    notices
      .getNewRinChangelogEntries(
        entries,
        "1.1.0-beta.20260518",
        "1.1.0-nightly.20260519+def5678",
      )
      .map((entry) => entry.content),
    ["new beta", "nightly"],
  );
  assert.deepEqual(
    notices
      .getNewRinChangelogEntries(entries, "abcdef012345", "1.1.0")
      .map((entry) => entry.content),
    [],
  );
  assert.equal(
    notices.comparePackageVersions("1.1.0+abc1234", "1.1.0+def5678"),
    0,
  );
});
