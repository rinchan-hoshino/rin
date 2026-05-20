import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const scriptPath = path.join(rootDir, "scripts", "install-git-hooks.ts");
const tsxBin = path.join(rootDir, "node_modules", ".bin", "tsx");

function makeTempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(command: string, args: string[], cwd: string) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("install git hooks configures fresh worktrees", () => {
  const tempDir = makeTempDir("rin-install-hooks-");
  try {
    run("git", ["init", "-b", "main"], tempDir);
    const hooksDir = path.join(tempDir, ".githooks");
    fs.mkdirSync(hooksDir);
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      "#!/usr/bin/env bash\nexit 0\n",
      "utf8",
    );

    const output = run(tsxBin, [scriptPath], tempDir);
    assert.match(output, /configured core\.hooksPath=\.githooks/);
    assert.equal(
      run("git", ["config", "--get", "core.hooksPath"], tempDir),
      ".githooks",
    );
    assert.equal(
      (fs.statSync(path.join(hooksDir, "pre-commit")).mode & 0o111) !== 0,
      true,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install git hooks resolves the worktree root from nested directories", () => {
  const tempDir = makeTempDir("rin-install-hooks-nested-");
  try {
    run("git", ["init", "-b", "main"], tempDir);
    const hooksDir = path.join(tempDir, ".githooks");
    const nestedDir = path.join(tempDir, "packages", "demo");
    fs.mkdirSync(hooksDir);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, "pre-commit"),
      "#!/usr/bin/env bash\nexit 0\n",
      "utf8",
    );

    const output = run(tsxBin, [scriptPath], nestedDir);
    assert.match(output, /configured core\.hooksPath=\.githooks/);
    assert.equal(
      run("git", ["config", "--get", "core.hooksPath"], tempDir),
      ".githooks",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("install git hooks is a no-op outside a worktree", () => {
  const tempDir = makeTempDir("rin-install-hooks-noop-");
  try {
    const output = run(tsxBin, [scriptPath], tempDir);
    assert.equal(output, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
