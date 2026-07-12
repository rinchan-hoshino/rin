import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkerProcessOptions = {
  workerPath: string;
  cwd: string;
  resourceOptionsDir?: string;
};

export function spawnWorkerProcess(
  options: WorkerProcessOptions,
  resourceOptions?: Record<string, unknown>,
  dependencies: {
    spawnImpl?: typeof spawn;
    executable?: string;
    pid?: number;
    randomHex?: () => string;
  } = {},
) {
  const args = [options.workerPath];
  if (resourceOptions) {
    const root =
      options.resourceOptionsDir ||
      path.join(os.tmpdir(), "rin-worker-options");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const randomHex =
      dependencies.randomHex || (() => crypto.randomBytes(8).toString("hex"));
    const filePath = path.join(
      root,
      `worker-options-${dependencies.pid ?? process.pid}-${randomHex()}.json`,
    );
    fs.writeFileSync(filePath, `${JSON.stringify(resourceOptions)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    args.push("--resource-options-file", filePath);
  }
  return (dependencies.spawnImpl || spawn)(
    dependencies.executable || process.execPath,
    args,
    {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    },
  );
}
