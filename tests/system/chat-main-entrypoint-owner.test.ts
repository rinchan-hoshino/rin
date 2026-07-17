import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(".");
const entrypoint = path.join(rootDir, "dist", "core", "chat", "main.js");
const registerFixture = path.join(
  rootDir,
  "tests",
  "support",
  "register-chat-main-owner-fixture.ts",
);
const contractChild = path.join(
  rootDir,
  "tests",
  "support",
  "chat-main-owner-child.ts",
);

async function createOwnerSandbox(label: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const sandbox = await createTestSandbox(root, { RIN_REPO_ROOT: rootDir });
  return { root, sandbox };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runDirectSignal(signal: "SIGINT" | "SIGTERM") {
  const { root, sandbox } = await createOwnerSandbox(
    `rin-chat-main-${signal.toLowerCase()}`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  let exitPromise:
    | Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>
    | undefined;
  try {
    child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", registerFixture, entrypoint],
      { cwd: rootDir, env: sandbox.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    exitPromise = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, exitSignal) => resolve({ code, exitSignal }));
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const readyDeadline = Date.now() + 5_000;
    while (!stdout.includes("chat bridge started")) {
      if (child.exitCode !== null) {
        throw new Error(
          `chat_main_exited_before_signal:${child.exitCode}\n${stdout}\n${stderr}`,
        );
      }
      if (Date.now() >= readyDeadline) {
        throw new Error(`chat_main_ready_timeout\n${stdout}\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill(signal);
    const result = await withTimeout(
      exitPromise,
      3_000,
      "chat_main_signal_timeout",
    );
    assert.deepEqual(result, { code: 0, exitSignal: null }, stderr);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    if (exitPromise) {
      await withTimeout(exitPromise, 1_000, "chat_main_kill_timeout").catch(
        () => {},
      );
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("chat main owns startup, configuration, bot, runtime, shutdown, and error contracts", async () => {
  const { root, sandbox } = await createOwnerSandbox("rin-chat-main-contract");
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--import", registerFixture, contractChild],
      { cwd: rootDir, env: sandbox.env, timeout: 20_000 },
    );
    const report = JSON.parse(result.stdout.trim().split(/\n/).at(-1) || "{}");
    assert.equal(report.ok, true);
    assert.ok(report.events > 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("chat main direct entrypoint reports startup failure", async () => {
  const { root, sandbox } = await createOwnerSandbox("rin-chat-main-failure");
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--import", registerFixture, entrypoint],
        {
          cwd: rootDir,
          env: {
            ...sandbox.env,
            RIN_TEST_CHAT_MAIN_APP_START_ERROR: "owner-startup-failed",
          },
          timeout: 5_000,
        },
      ),
      (error: any) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /owner-startup-failed/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("chat main direct entrypoint shuts down cleanly for both process signals", async () => {
  await runDirectSignal("SIGINT");
  await runDirectSignal("SIGTERM");
});
