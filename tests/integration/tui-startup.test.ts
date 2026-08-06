import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const launcher = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "launcher.js"))
    .href
);

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tui-e2e-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("tui startup falls back before rpc mode when daemon health check fails", async () => {
  await withTempDir(async (tempDir) => {
    const runtimeDir = path.join(tempDir, "runtime");
    await fs.mkdir(runtimeDir, { recursive: true });

    const socketPath = path.join(runtimeDir, "daemon.sock");
    await fs.writeFile(socketPath, "", "utf8");

    assert.equal(
      await launcher.isDaemonReadyForRpcStartup({ socketPath, timeoutMs: 100 }),
      false,
    );
  });
});
