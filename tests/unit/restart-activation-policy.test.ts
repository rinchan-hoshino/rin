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

test("rin update preflights, stops, migrates, activates, and restarts in order", () => {
  const finalize = source("src/core/rin-install/finalize.ts");
  const restartBlock = finalize.slice(
    finalize.indexOf("function managedRuntimeServiceFromInstallSpec"),
    finalize.indexOf("export async function finalizeQuickRunInstall"),
  );

  assert.match(restartBlock, /tryManagedServiceAction\([\s\S]*"restart"/);
  assert.match(
    restartBlock,
    /if \(publishRuntime && !manageDaemon\)[\s\S]*requires managed daemon control/,
  );
  assert.match(
    restartBlock,
    /serviceFileHoldCommand:[\s\S]*executionContext\.targetNodePath[\s\S]*service-file-hold\.js/,
  );
  const preflightIndex = restartBlock.indexOf(
    "preflightInstallUpgradeMigrations",
  );
  const holdIndex = restartBlock.indexOf(
    "setManagedServiceStartHold(serviceContext, true",
  );
  const stopIndex = restartBlock.indexOf('"stop"');
  const mutateIndex = restartBlock.indexOf("mutate: writeInstalledState");
  const activateIndex = restartBlock.indexOf("activate:", mutateIndex);
  const finalizeMigrationIndex = restartBlock.indexOf(
    "finalizeInstallUpgradeMigrations",
    activateIndex,
  );
  const releaseIndex = restartBlock.indexOf(
    "setManagedServiceStartHold(serviceContext, false",
    activateIndex,
  );
  const restartIndex = restartBlock.indexOf("restart:", activateIndex);
  const daemonRestartIndex = restartBlock.indexOf(
    'tryManagedServiceAction(serviceContext, "restart"',
    releaseIndex,
  );
  assert.ok(
    preflightIndex >= 0 && preflightIndex < holdIndex,
    "migration preparation must finish before the daemon start hold",
  );
  assert.ok(
    holdIndex >= 0 && holdIndex < stopIndex,
    "service starts must be persistently disabled before the old daemon stops",
  );
  assert.ok(
    preflightIndex >= 0 && preflightIndex < stopIndex,
    "read-only migration preflight must finish before daemon stop",
  );
  assert.ok(
    stopIndex >= 0 && stopIndex < mutateIndex,
    "the old daemon must stop before installer-owned migrations",
  );
  assert.ok(
    mutateIndex >= 0 && mutateIndex < activateIndex,
    "migrations must finish before runtime activation",
  );
  assert.ok(
    activateIndex >= 0 && activateIndex < finalizeMigrationIndex,
    "runtime activation must finish before finalizing the data migration",
  );
  assert.ok(
    finalizeMigrationIndex >= 0 && finalizeMigrationIndex < releaseIndex,
    "data migration must finalize before releasing the service start hold",
  );
  assert.ok(
    activateIndex >= 0 && activateIndex < releaseIndex,
    "runtime activation must finish before releasing the service start hold",
  );
  assert.match(restartBlock, /rollbackInstallUpgradeMigrations/);
  assert.ok(
    releaseIndex >= 0 && releaseIndex < daemonRestartIndex,
    "service starts must be released before daemon restart",
  );
  assert.ok(
    activateIndex >= 0 && activateIndex < restartIndex,
    "runtime activation must finish before daemon restart",
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
