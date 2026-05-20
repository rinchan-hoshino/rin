import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const cliPath = path.join(rootDir, "dist", "app", "rin", "main.js");
const tuiPath = path.join(rootDir, "dist", "app", "rin-tui", "main.js");

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-cli-interactive-"));
  try {
    await fn(dir);
  } finally {
    await removeDirRobust(dir);
  }
}

async function commandExists(name: string) {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function setupIsolatedCliEnv(tempDir: string) {
  const home = path.join(tempDir, "home");
  const agentDir = path.join(tempDir, "agent");
  const runtimeDir = path.join(tempDir, "runtime");
  const configDir = path.join(home, ".config", "rin");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "install.json"),
    `${JSON.stringify({ defaultInstallDir: rootDir }, null, 2)}\n`,
    "utf8",
  );

  return {
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
      RIN_DIR: agentDir,
      RIN_DIR: agentDir,
      NO_COLOR: "1",
      TERM: "xterm-256color",
    },
  };
}

test(
  "maintenance mode TUI can boot in an isolated pseudo-terminal smoke run",
  {
    skip:
      process.env.RIN_RUN_INTERACTIVE_TESTS === "1"
        ? false
        : "set RIN_RUN_INTERACTIVE_TESTS=1 to run the opt-in interactive smoke test",
  },
  async () => {
    if (!(await commandExists("script"))) {
      test.skip("missing util-linux script command");
      return;
    }

    await withTempDir(async (tempDir) => {
      const { env } = await setupIsolatedCliEnv(tempDir);
      const child = spawn(
        "script",
        ["-qfec", `${process.execPath} ${tuiPath}`, "/dev/null"],
        {
          cwd: rootDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });

      const startedAt = Date.now();
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(child.exitCode, null);
        child.stdin.write("\u0003");
        child.stdin.end();

        const result = await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("interactive_smoke_timeout")),
              8000,
            ),
          ),
        ]);

        assert.ok(Date.now() - startedAt >= 1500);
        assert.ok(
          result.code === 0 ||
            result.code === 130 ||
            result.signal === "SIGINT",
        );
        assert.doesNotMatch(output, /rin_not_installed/);
      } finally {
        child.kill("SIGTERM");
        await execFileAsync(process.execPath, [cliPath, "stop"], {
          cwd: rootDir,
          env,
        }).catch(() => undefined);
      }
    });
  },
);
