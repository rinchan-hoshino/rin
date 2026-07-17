import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { importBuiltModule } from "../support/import-built-module.js";

const notices = await importBuiltModule<
  typeof import("../../src/core/rin-lib/update-notices.js")
>("dist/core/rin-lib/update-notices.js");
const execFileAsync = promisify(execFile);

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-notice-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function git(cwd: string, ...args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

test("update notices parse and order release versions and changelog headings", () => {
  assert.deepEqual(notices.parsePackageVersion(" v1.2.3-beta.10+build "), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ["beta", "10"],
  });
  for (const invalid of ["", "1.2", "one.2.3"])
    assert.equal(notices.parsePackageVersion(invalid), undefined);
  const ordered = [
    ["1.0.1", "1.0.0"],
    ["1.1.0", "1.0.9"],
    ["2.0.0", "1.9.9"],
    ["1.0.0", "1.0.0-beta"],
    ["1.0.0-beta.2", "1.0.0-beta.1"],
    ["1.0.0-beta.1", "1.0.0-beta"],
    ["1.0.0-rc", "1.0.0-1"],
    ["1.0.0-beta.b", "1.0.0-beta.a"],
  ];
  for (const [newer, older] of ordered) {
    assert.ok(
      notices.comparePackageVersions(newer, older) > 0,
      `${newer} > ${older}`,
    );
    assert.ok(
      notices.comparePackageVersions(older, newer) < 0,
      `${older} < ${newer}`,
    );
  }
  assert.equal(notices.comparePackageVersions("bad", "1.0.0"), 0);
  assert.equal(notices.comparePackageVersions("1.0.0+one", "1.0.0+two"), 0);
  assert.equal(
    notices.versionFromRinChangelogHeading("[v1.2.3-beta.1] - title"),
    "v1.2.3-beta.1",
  );
  assert.equal(
    notices.versionFromRinChangelogHeading("title 1.2.3"),
    undefined,
  );
  const entries = [
    { heading: "1.2.0", content: "stable" },
    { heading: "1.1.1", content: "patch" },
    { heading: "invalid", content: "ignored" },
  ];
  assert.deepEqual(
    notices.getNewRinChangelogEntries(entries, "1.1.0", "1.1.1"),
    [entries[1]],
  );
  assert.deepEqual(notices.getNewRinChangelogEntries(entries, "bad"), []);
  assert.deepEqual(notices.getNewRinChangelogEntries(entries, "1.1.0"), [
    entries[0],
    entries[1],
  ]);
  assert.equal(
    notices.getRinChangelogUrl(),
    "https://github.com/rinchan-hoshino/rin/blob/main/docs/release/CHANGELOG.md",
  );
});

test("update notices normalize installed metadata and infer channels", async () => {
  await withTempDir(async (directory) => {
    assert.equal(notices.readInstalledRinReleaseInfo(directory), undefined);
    await fs.writeFile(path.join(directory, "installer.json"), "{bad");
    assert.equal(notices.readInstalledRinReleaseInfo(directory), undefined);

    const releases = [
      {
        input: {
          channel: "nightly",
          version: "1.2.3-nightly.4",
          installedAt: "now",
        },
        expected: {
          channel: "nightly",
          version: "1.2.3-nightly.4",
          branch: "main",
          ref: "1.2.3-nightly.4",
          sourceLabel: "nightly 1.2.3-nightly.4",
          archiveUrl: "",
          installedAt: "now",
        },
      },
      {
        input: {
          channel: "git",
          version: "abcdef1234567890",
          branch: "feature",
        },
        expected: {
          channel: "git",
          version: "abcdef1234567890",
          branch: "feature",
          ref: "abcdef1234567890",
          sourceLabel: "git feature",
          archiveUrl: "",
        },
      },
      {
        input: {
          channel: "git",
          version: "label",
          ref: "1234567890abcdef",
          archiveUrl: "archive",
        },
        expected: {
          channel: "git",
          version: "1234567890ab",
          branch: "main",
          ref: "1234567890abcdef",
          sourceLabel: "git main",
          archiveUrl: "archive",
        },
      },
      {
        input: { channel: "invalid", ref: "1.0.0" },
        expected: {
          channel: "stable",
          version: "unknown",
          branch: "stable",
          ref: "1.0.0",
          sourceLabel: "stable 1.0.0",
          archiveUrl: "",
        },
      },
    ];
    for (const { input, expected } of releases) {
      await fs.writeFile(
        path.join(directory, "installer.json"),
        JSON.stringify({ currentRelease: { release: input } }),
      );
      assert.deepEqual(
        notices.readInstalledRinReleaseInfo(directory),
        expected,
      );
    }
    await fs.writeFile(
      path.join(directory, "installer.json"),
      JSON.stringify({ currentRelease: { release: {} } }),
    );
    assert.equal(notices.readInstalledRinReleaseInfo(directory), undefined);
  });

  assert.equal(
    notices.getCurrentRinVersion(undefined, { version: " 1.2.3 " } as any),
    "1.2.3",
  );
  assert.equal(notices.inferRinReleaseChannel("1.2.3-nightly.1"), "nightly");
  assert.equal(notices.inferRinReleaseChannel("1.2.3-beta.1"), "beta");
  assert.equal(
    notices.inferRinReleaseChannel("custom", { channel: "git" } as any),
    "git",
  );
  assert.equal(notices.inferRinReleaseChannel("custom"), "stable");
  for (const channel of ["stable", "beta", "nightly", "git"] as const) {
    assert.equal(notices.rinUpdateCommandForChannel(channel), "rin update");
  }
});

test("update notices compare supplied stable, beta, nightly, skip, and offline manifests", async () => {
  const manifest = {
    stable: { version: "2.0.0" },
    beta: { version: "2.1.0-beta.2" },
    nightly: { version: "2.1.0-nightly.2" },
  } as any;
  assert.deepEqual(
    await notices.checkForRinUpdateNotice({
      currentVersion: "1.0.0",
      channel: "stable",
      manifest,
    }),
    {
      version: "2.0.0",
      channel: "stable",
      currentVersion: "1.0.0",
      command: "rin update",
    },
  );
  assert.equal(
    await notices.checkForRinUpdateNotice({
      currentVersion: "2.0.0",
      channel: "stable",
      manifest,
    }),
    undefined,
  );
  assert.equal(
    await notices.checkForRinUpdateNotice({
      currentVersion: "bad",
      channel: "stable",
      manifest,
    }),
    undefined,
  );
  assert.equal(
    await notices.checkForRinUpdateNotice({
      currentVersion: "1.0.0",
      channel: "stable",
      manifest: { stable: { version: "bad" } } as any,
    }),
    undefined,
  );
  assert.equal(
    await notices.checkForNewRinVersion({
      currentVersion: "2.1.0-beta.1",
      channel: "beta",
      manifest,
    }),
    "2.1.0-beta.2",
  );
  assert.equal(
    (
      await notices.checkForRinUpdateNotice({
        currentVersion: "2.1.0-nightly.1",
        manifest,
      })
    )?.channel,
    "nightly",
  );

  const previousSkip = process.env.RIN_SKIP_VERSION_CHECK;
  const previousOffline = process.env.RIN_OFFLINE;
  try {
    process.env.RIN_SKIP_VERSION_CHECK = "1";
    assert.equal(
      await notices.checkForRinUpdateNotice({
        currentVersion: "1.0.0",
        manifest,
      }),
      undefined,
    );
    delete process.env.RIN_SKIP_VERSION_CHECK;
    process.env.RIN_OFFLINE = "1";
    assert.equal(
      await notices.checkForRinUpdateNotice({
        currentVersion: "1.0.0",
        manifest,
      }),
      undefined,
    );
  } finally {
    if (previousSkip === undefined) delete process.env.RIN_SKIP_VERSION_CHECK;
    else process.env.RIN_SKIP_VERSION_CHECK = previousSkip;
    if (previousOffline === undefined) delete process.env.RIN_OFFLINE;
    else process.env.RIN_OFFLINE = previousOffline;
  }
});

test("update notices compare local git branch refs without network access", async () => {
  await withTempDir(async (directory) => {
    await git(directory, "init", "-b", "main");
    await git(directory, "config", "user.email", "rin@example.invalid");
    await git(directory, "config", "user.name", "Rin Test");
    await fs.writeFile(path.join(directory, "file"), "one\n");
    await git(directory, "add", "file");
    await git(directory, "commit", "-m", "one");
    const first = (await git(directory, "rev-parse", "HEAD")).stdout.trim();
    await fs.writeFile(path.join(directory, "file"), "two\n");
    await git(directory, "commit", "-am", "two");
    const second = (await git(directory, "rev-parse", "HEAD")).stdout.trim();
    const currentRelease = {
      channel: "git" as const,
      version: first.slice(0, 12),
      branch: "main",
      ref: first,
      sourceLabel: "git main",
      archiveUrl: "",
    };
    assert.equal(
      await notices.latestRinVersionForChannel({
        currentRelease,
        manifest: { git: { repoUrl: directory, defaultBranch: "main" } } as any,
      }),
      second,
    );
    assert.equal(
      (
        await notices.checkForRinUpdateNotice({
          currentRelease,
          manifest: {
            git: { repoUrl: directory, defaultBranch: "main" },
          } as any,
        })
      )?.version,
      second.slice(0, 12),
    );
    assert.equal(
      await notices.checkForRinUpdateNotice({
        currentRelease: { ...currentRelease, ref: second.slice(0, 8) },
        manifest: { git: { repoUrl: directory, defaultBranch: "main" } } as any,
      }),
      undefined,
    );
    assert.equal(
      await notices.checkForRinUpdateNotice({
        currentRelease: { ...currentRelease, version: "unknown", ref: "" },
        manifest: { git: { repoUrl: directory, defaultBranch: "main" } } as any,
      }),
      undefined,
    );
    assert.equal(
      await notices.latestRinVersionForChannel({
        currentRelease,
        manifest: {} as any,
      }),
      undefined,
    );
    assert.equal(
      await notices.latestRinVersionForChannel({
        currentRelease: { ...currentRelease, branch: "missing" },
        manifest: { git: { repoUrl: directory, defaultBranch: "main" } } as any,
      }),
      undefined,
    );
  });
});
