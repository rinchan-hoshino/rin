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
const notices = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "update-notices.js"),
  ).href
);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-update-notices-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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

test("Rin changelog entries read docs/rin without settings state", async () => {
  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    try {
      process.env.RIN_DIR = dir;
      const changelogPath = path.join(dir, "docs", "rin", "CHANGELOG.md");
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
