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

test("rin restart performs one managed restart and verifies a new daemon generation", () => {
  const control = source("src/core/rin/control.ts");
  const restartBlock = control.slice(
    control.indexOf("export async function runRestart"),
    control.length,
  );

  assert.match(restartBlock, /queryDaemonStatus/);
  assert.match(restartBlock, /tryManagedServiceAction\(context, "restart"\)/);
  assert.match(restartBlock, /activateDaemonRestart/);
  assert.doesNotMatch(restartBlock, /prepareDaemonRestart/);
  assert.doesNotMatch(restartBlock, /cancelDaemonRestart/);
  assert.doesNotMatch(restartBlock, /waitForDaemonDrain/);
});

test("rin update writes service files passively then verifies one restart", () => {
  const finalize = source("src/core/rin-install/finalize.ts");
  const restartActivationBlock = finalize.slice(
    finalize.indexOf("async function snapshotInstalledDaemonRestart"),
    finalize.indexOf("export async function finalizeQuickRunInstall"),
  );

  assert.match(restartActivationBlock, /queryInstalledDaemonStatus/);
  assert.match(
    restartActivationBlock,
    /tryManagedServiceAction\([\s\S]*"restart"/,
  );
  assert.match(restartActivationBlock, /activateDaemonRestart/);
  assert.match(
    restartActivationBlock,
    /installDaemonService\([\s\S]*activate:\s*false/,
  );
  assert.equal(
    restartActivationBlock.match(/installDaemonService\(/g)?.length,
    1,
  );
  assert.doesNotMatch(restartActivationBlock, /prepareInstalledDaemonRestart/);
  assert.doesNotMatch(restartActivationBlock, /cancelInstalledDaemonRestart/);
});

test("hosted chat bridge has no restart-specific quiescing state", () => {
  const daemon = source("src/app/rin-daemon/daemon.ts");
  const chat = source("src/core/chat/main.ts");
  const shared = source("src/core/rin/shared.ts");

  assert.doesNotMatch(daemon, /daemon_prepare_restart|daemon_cancel_restart/);
  assert.doesNotMatch(chat, /quiesc/i);
  assert.doesNotMatch(shared, /prepareDaemonRestart|cancelDaemonRestart/);
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
