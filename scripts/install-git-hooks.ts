import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function runGit(args: string[], options: { cwd?: string } = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  }).trim();
}

function findRepoRoot(cwd: string) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], { cwd }) || null;
  } catch {
    return null;
  }
}

const repoRoot = findRepoRoot(process.cwd());
if (!repoRoot) process.exit(0);

const preCommit = path.join(repoRoot, ".githooks", "pre-commit");
if (!fs.existsSync(preCommit)) process.exit(0);

try {
  fs.chmodSync(preCommit, 0o755);
} catch {
  // The executable bit is tracked by git; chmod is only a best-effort repair for odd filesystems.
}

runGit(["config", "core.hooksPath", ".githooks"], { cwd: repoRoot });
console.log("rin git hooks: configured core.hooksPath=.githooks");
