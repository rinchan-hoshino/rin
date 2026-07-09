import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

function source(relativePath: string) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

test("rin restart activation interrupts active work instead of requiring idle drain", () => {
  const control = source("src/core/rin/control.ts");
  const restartBlock = control.slice(
    control.indexOf("export async function runRestart"),
    control.length,
  );

  assert.match(restartBlock, /prepareDaemonRestart\(\)/);
  assert.match(restartBlock, /tryManagedServiceAction\(context, "restart"\)/);
  assert.doesNotMatch(restartBlock, /waitForDaemonDrain/);
  assert.doesNotMatch(restartBlock, /daemon still has active turns/);
});

test("rin update restart activation does not wait for active turns to drain", () => {
  const finalize = source("src/core/rin-install/finalize.ts");
  const restartActivationBlock = finalize.slice(
    finalize.indexOf("async function prepareInstalledDaemonRestartActivation"),
    finalize.indexOf("export async function finalizeQuickRunInstall"),
  );

  assert.match(restartActivationBlock, /prepareInstalledDaemonRestart\(/);
  assert.match(
    restartActivationBlock,
    /tryManagedServiceAction\([\s\S]*"restart"/,
  );
  assert.doesNotMatch(restartActivationBlock, /waitForDaemonDrain/);
  assert.doesNotMatch(
    restartActivationBlock,
    /Cannot restart after update yet/,
  );
});

test("daemon shutdown remains the owner of interrupting active workers", () => {
  const workerPool = source("src/core/rin-daemon/worker-pool.ts");
  const shutdownBlock = workerPool.slice(
    workerPool.indexOf("async shutdown(graceMs: number)"),
    workerPool.indexOf("private updateWorkerMetadata"),
  );

  assert.match(shutdownBlock, /this\.beginShutdown\(\)/);
  assert.match(shutdownBlock, /this\.destroyAll\(\)/);
});
