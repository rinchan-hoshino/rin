import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

function source(relativePath: string) {
  return readFileSync(path.join(rootDir, relativePath), "utf8");
}

test("rin restart performs one managed restart and waits only for daemon availability", () => {
  const control = source("src/core/rin/control.ts");
  const restartBlock = control.slice(
    control.indexOf("export async function runRestart"),
    control.length,
  );

  assert.match(restartBlock, /tryManagedServiceAction\(context, "restart"\)/);
  assert.match(restartBlock, /waitForDaemonAvailable/);
  assert.doesNotMatch(restartBlock, /queryDaemonStatus/);
  assert.doesNotMatch(restartBlock, /activateDaemonRestart/);
  assert.doesNotMatch(restartBlock, /snapshotDaemonRestart/);
  assert.doesNotMatch(restartBlock, /prepareDaemonRestart/);
  assert.doesNotMatch(restartBlock, /cancelDaemonRestart/);
  assert.doesNotMatch(restartBlock, /waitForDaemonDrain/);
});

test("rin update writes service files passively, restarts once, and waits for the socket", () => {
  const finalize = source("src/core/rin-install/finalize.ts");
  const restartBlock = finalize.slice(
    finalize.indexOf("function managedRuntimeServiceFromInstallSpec"),
    finalize.indexOf("export async function finalizeQuickRunInstall"),
  );

  assert.match(restartBlock, /tryManagedServiceAction\([\s\S]*"restart"/);
  const persistIndex = restartBlock.indexOf("const written =");
  const stopIndex = restartBlock.indexOf('"stop"');
  const restartIndex = restartBlock.indexOf('"restart"', persistIndex);
  assert.ok(
    stopIndex >= 0 && stopIndex < persistIndex,
    "the old daemon must stop before installer-owned migrations",
  );
  assert.ok(
    persistIndex >= 0 && persistIndex < restartIndex,
    "installer persistence and migrations must finish before daemon restart",
  );
  assert.match(restartBlock, /waitForSocket/);
  assert.doesNotMatch(restartBlock, /queryInstalledDaemonStatus/);
  assert.doesNotMatch(restartBlock, /activateDaemonRestart/);
  assert.doesNotMatch(restartBlock, /snapshotDaemonRestart/);
  assert.match(restartBlock, /installDaemonService\([\s\S]*activate:\s*false/);
  assert.equal(restartBlock.match(/installDaemonService\(/g)?.length, 1);
  assert.doesNotMatch(restartBlock, /prepareInstalledDaemonRestart/);
  assert.doesNotMatch(restartBlock, /cancelInstalledDaemonRestart/);
  assert.equal(
    existsSync(
      path.join(rootDir, "src", "core", "rin", "daemon-activation.ts"),
    ),
    false,
  );
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
