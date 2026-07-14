import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const cliPath = path.join(rootDir, "dist", "app", "rin", "main.js");
const daemonPath = path.join(rootDir, "dist", "app", "rin-daemon", "daemon.js");

async function removeDirRobust(dir: string, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cli-e2e-"));
  try {
    await fn(dir);
  } finally {
    await removeDirRobust(dir);
  }
}

async function setupIsolatedCliEnv(tempDir: string) {
  const sandbox = await createTestSandbox(tempDir, { TERM: "dumb" });
  const configDir = path.join(sandbox.configDir, "rin");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "install.json"),
    `${JSON.stringify({ defaultInstallDir: rootDir }, null, 2)}\n`,
    "utf8",
  );

  return { agentDir: sandbox.agentDir, env: sandbox.env };
}

async function runCli(args: string[], env: Record<string, string>) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: rootDir,
    env,
  });
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

async function waitForSocketState(
  env: Record<string, string>,
  expected: "yes" | "no",
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const { stdout } = await runCli(["doctor", "--json"], env);
    const status = JSON.parse(stdout);
    if (status.socketReady === (expected === "yes")) return stdout;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed_out_waiting_for_socket_${expected}`);
}

test("isolated CLI doctor flow sees a daemon booted in a temporary agent dir", async () => {
  await withTempDir(async (tempDir) => {
    const { agentDir, env } = await setupIsolatedCliEnv(tempDir);
    const before = await runCli(["doctor", "--json"], env);
    assert.equal(JSON.parse(before.stdout).socketReady, false);

    const daemon = spawn(process.execPath, [daemonPath], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let daemonLog = "";
    daemon.stdout.on("data", (chunk) => {
      daemonLog += String(chunk);
    });
    daemon.stderr.on("data", (chunk) => {
      daemonLog += String(chunk);
    });

    const daemonExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.once("exit", (code, signal) => resolve({ code, signal }));
    });

    try {
      const doctor = await waitForSocketState(env, "yes");
      const doctorStatus = JSON.parse(doctor);
      assert.equal(doctorStatus.socketReady, true);
      assert.ok(doctorStatus.targetUser);

      const agentData = path.join(agentDir, "data");
      await assert.doesNotReject(() => fs.access(agentData));
    } finally {
      daemon.kill("SIGTERM");
      const result = await Promise.race([
        daemonExit,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) =>
            setTimeout(async () => {
              daemon.kill("SIGKILL");
              resolve(await daemonExit);
            }, 2500),
        ),
      ]);
      assert.ok(
        result.code === 0 ||
          result.signal === "SIGTERM" ||
          result.signal === "SIGKILL",
        daemonLog,
      );
      await waitForSocketState(env, "no", 5000).catch(() => undefined);
    }
  });
});
