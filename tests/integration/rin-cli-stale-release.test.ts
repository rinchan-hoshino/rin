import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

async function waitForReady(child: ReturnType<typeof spawn>) {
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.off("data", onData);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `CLI exited before readiness with code ${String(code)}; stdout=${stdout}`,
        ),
      );
    };
    const onData = (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.includes("stale-release-test-ready")) {
        cleanup();
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(`timed out waiting for CLI readiness; stdout=${stdout}`),
      );
    }, 5_000);

    if (child.exitCode !== null || child.signalCode !== null) {
      onClose(child.exitCode);
      return;
    }
    child.once("error", onError);
    child.once("close", onClose);
    child.stdout?.on("data", onData);
  });
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    },
  );
}

test("CLI preserves its error formatter after its installed release is pruned", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-cli-stale-release-"),
  );
  const releaseRoot = path.join(tempDir, "app", "releases", "old-release");
  const triggerPath = path.join(tempDir, "reject-cli");
  const entrypoint = path.join(releaseRoot, "dist", "app", "rin", "main.js");
  let child: ReturnType<typeof spawn> | undefined;
  let exitPromise: Promise<{ code: number | null; stderr: string }> | undefined;

  try {
    await fs.mkdir(path.dirname(entrypoint), { recursive: true });
    await fs.mkdir(path.join(releaseRoot, "dist", "core", "rin"), {
      recursive: true,
    });
    await fs.mkdir(path.join(releaseRoot, "dist", "core", "presentation"), {
      recursive: true,
    });
    await fs.mkdir(path.join(releaseRoot, "dist", "core", "platform"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(releaseRoot, "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
      "utf8",
    );
    await fs.copyFile(
      path.join(rootDir, "dist", "app", "rin", "main.js"),
      entrypoint,
    );
    await fs.copyFile(
      path.join(rootDir, "dist", "core", "platform", "process-lifetime.js"),
      path.join(releaseRoot, "dist", "core", "platform", "process-lifetime.js"),
    );
    await fs.writeFile(
      path.join(releaseRoot, "dist", "core", "rin", "main.js"),
      `import fs from "node:fs";

export async function startRinCli() {
  console.log("stale-release-test-ready");
  while (!fs.existsSync(process.env.RIN_STALE_RELEASE_TRIGGER)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("original_cli_failure");
}
`,
      "utf8",
    );
    await fs.writeFile(
      path.join(releaseRoot, "dist", "core", "presentation", "error.js"),
      `export function formatRuntimeErrorForUser(error) {
  return "formatted:" + String(error?.message || error);
}
`,
      "utf8",
    );

    child = spawn(process.execPath, [entrypoint], {
      cwd: tempDir,
      env: {
        ...process.env,
        RIN_STALE_RELEASE_TRIGGER: triggerPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitPromise = waitForExit(child);

    await waitForReady(child);
    await fs.rm(releaseRoot, { recursive: true, force: true });
    await fs.writeFile(triggerPath, "reject\n", "utf8");

    const result = await exitPromise;
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "formatted:original_cli_failure");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exitPromise?.catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
