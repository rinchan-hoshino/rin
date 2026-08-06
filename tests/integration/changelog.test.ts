import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const changelog = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "changelog.js"))
    .href
);

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-changelog-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("changelog parser ignores intro text, skips empty sections, and normalizes BOM/CRLF", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "CHANGELOG.md");
    await fs.writeFile(
      filePath,
      `\uFEFF${[
        "# Changelog",
        "",
        "Intro text that should be ignored.",
        "",
        "## 1.2.0",
        "",
        "- Added feature A",
        "- Fixed bug B",
        "",
        "## 1.1.0",
        "",
        "## 1.0.0",
        "",
        "- Initial release",
        "",
      ].join("\r\n")}`,
      "utf8",
    );

    assert.deepEqual(changelog.parseChangelog(filePath), [
      {
        heading: "1.2.0",
        content: "## 1.2.0\n- Added feature A\n- Fixed bug B",
      },
      {
        heading: "1.0.0",
        content: "## 1.0.0\n- Initial release",
      },
    ]);
  });
});

test("changelog parser returns empty entries for missing paths", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(
      changelog.parseChangelog(path.join(dir, "missing.md")),
      [],
    );

    const filePath = path.join(dir, "not-a-dir");
    await fs.writeFile(filePath, "not a directory", "utf8");
    assert.deepEqual(
      changelog.parseChangelog(path.join(filePath, "CHANGELOG.md")),
      [],
    );
  });
});

test("changelog path prefers runtime release docs when that file exists", async () => {
  await withTempDir(async (dir) => {
    const previousRinDir = process.env.RIN_DIR;
    try {
      process.env.RIN_DIR = dir;
      const expectedPath = path.join(dir, "docs", "release", "CHANGELOG.md");
      await fs.mkdir(path.dirname(expectedPath), { recursive: true });
      await fs.writeFile(expectedPath, "## 1.0.0\n- Ready\n", "utf8");
      assert.equal(changelog.getChangelogPath(), expectedPath);
    } finally {
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }
  });
});

test("changelog path falls back to home release docs when runtime file is missing", async () => {
  await withTempDir(async (dir) => {
    const previousHome = process.env.HOME;
    const previousRinDir = process.env.RIN_DIR;
    try {
      process.env.HOME = dir;
      process.env.RIN_DIR = path.join(dir, "runtime-agent");
      const expectedPath = path.join(
        dir,
        ".rin",
        "docs",
        "release",
        "CHANGELOG.md",
      );
      await fs.mkdir(path.dirname(expectedPath), { recursive: true });
      await fs.writeFile(expectedPath, "## 1.0.0\n- Ready\n", "utf8");
      assert.equal(changelog.getChangelogPath(), expectedPath);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousRinDir === undefined) delete process.env.RIN_DIR;
      else process.env.RIN_DIR = previousRinDir;
    }
  });
});
