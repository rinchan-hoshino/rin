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

const hooks = ["pre-commit", "pre-push"].map((hook) =>
  path.join(repoRoot, ".githooks", hook),
);
if (!hooks.some((hook) => fs.existsSync(hook))) process.exit(0);

for (const hook of hooks) {
  if (!fs.existsSync(hook)) continue;
  try {
    fs.chmodSync(hook, 0o755);
  } catch {
    // The executable bit is tracked by git; chmod is only a best-effort repair for odd filesystems.
  }
}

runGit(["config", "core.hooksPath", ".githooks"], { cwd: repoRoot });
console.log("rin git hooks: configured core.hooksPath=.githooks");
