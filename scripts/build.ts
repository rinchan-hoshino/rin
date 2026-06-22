import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const coreOnly = process.argv.includes("--core");

function runNodeScript(scriptPath: string, args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.rmSync(path.join(rootDir, "dist"), { recursive: true, force: true });
runNodeScript(path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), [
  "-p",
  "tsconfig.json",
  "--pretty",
  "false",
]);

if (!coreOnly && process.platform !== "win32") {
  for (const relativePath of [
    "dist/app/rin/main.js",
    "dist/app/rin-daemon/daemon.js",
    "dist/app/rin-daemon/worker.js",
    "dist/app/rin-tui/main.js",
    "dist/app/rin-install/main.js",
  ]) {
    fs.chmodSync(path.join(rootDir, relativePath), 0o755);
  }
}
