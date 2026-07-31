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
  assert.ok(
    restartBlock.indexOf("assertLifecycleUpdateFence") <
      restartBlock.indexOf('tryManagedServiceAction(context, "restart")'),
    "explicit restart must clear a stale fence or reject a live update before systemd",
  );
  assert.match(
    control,
    /if \(context\.isTargetUser\)[\s\S]*assertNoDaemonUpdateInProgress[\s\S]*context\.exec\([\s\S]*update-fence-check\.js/,
  );
  assert.match(restartBlock, /waitForDaemonAvailable/);
  assert.doesNotMatch(restartBlock, /queryDaemonStatus/);
  assert.doesNotMatch(restartBlock, /activateDaemonRestart/);
  assert.doesNotMatch(restartBlock, /snapshotDaemonRestart/);
  assert.doesNotMatch(restartBlock, /prepareDaemonRestart/);
  assert.doesNotMatch(restartBlock, /cancelDaemonRestart/);
  assert.doesNotMatch(restartBlock, /waitForDaemonDrain/);
});

test("rin update fences daemon startup without masking the managed service", () => {
  const finalize = source("src/core/rin-install/finalize.ts");
  const service = source("src/core/rin-install/service.ts");
  const restartBlock = finalize.slice(
    finalize.indexOf("function managedRuntimeServiceFromInstallSpec"),
    finalize.indexOf("export async function finalizeQuickRunInstall"),
  );

  assert.match(restartBlock, /acquireTargetDaemonUpdateFence/);
  assert.match(restartBlock, /stopManagedRuntimeForUpdate/);
  assert.match(restartBlock, /tryManagedServiceAction\([\s\S]*"restart"/);
  assert.match(
    restartBlock,
    /if \(publishRuntime && !manageDaemon\)[\s\S]*requires managed daemon control/,
  );
  assert.doesNotMatch(restartBlock, /setManagedServiceStartHold/);
  assert.doesNotMatch(restartBlock, /service-file-hold/);
  assert.doesNotMatch(restartBlock, /"mask"|"unmask"/);
  assert.match(service, /ConditionPathExists=!%t\/rin-daemon\/update\.lock/);

  const preflightIndex = restartBlock.indexOf(
    "preflightInstallUpgradeMigrations",
  );
  const fenceIndex = restartBlock.indexOf("acquireTargetDaemonUpdateFence");
  const stopIndex = restartBlock.indexOf(
    "stopManagedRuntimeForUpdate",
    fenceIndex + 1,
  );
  const migrationLockIndex = restartBlock.indexOf(
    "acquireTargetDaemonMigrationLock",
    stopIndex,
  );
  const quiescedIndex = restartBlock.indexOf(
    "migrationOptions.chatRuntimeQuiesced = true",
  );
  const mutateIndex = restartBlock.indexOf("mutate: writeInstalledState");
  const activateIndex = restartBlock.indexOf("activate:", mutateIndex);
  const finalizeMigrationIndex = restartBlock.indexOf(
    "finalizeInstallUpgradeMigrations",
    activateIndex,
  );
  const restartIndex = restartBlock.indexOf("restart:", activateIndex);
  const daemonRestartIndex = restartBlock.indexOf(
    'tryManagedServiceAction(serviceContext, "restart"',
    restartIndex,
  );
  assert.ok(
    preflightIndex >= 0 && preflightIndex < fenceIndex,
    "migration preflight must finish before the update fence",
  );
  assert.ok(
    fenceIndex >= 0 && fenceIndex < stopIndex,
    "the update fence must be acquired before daemon stop",
  );
  assert.ok(
    stopIndex >= 0 && stopIndex < migrationLockIndex,
    "the installer must request daemon stop before proving exclusive ownership",
  );
  assert.ok(
    migrationLockIndex >= 0 && migrationLockIndex < quiescedIndex,
    "the installer must hold the daemon instance lease before authorizing interruption",
  );
  assert.ok(
    quiescedIndex >= 0 && quiescedIndex < mutateIndex,
    "runtime quiescence must be recorded before installer-owned migrations",
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
    finalizeMigrationIndex >= 0 && finalizeMigrationIndex < restartIndex,
    "data migration must finalize before daemon restart",
  );
  assert.ok(
    restartIndex >= 0 && restartIndex < daemonRestartIndex,
    "the transition restart step must own the managed daemon restart",
  );
  assert.match(restartBlock, /rollbackInstallUpgradeMigrations/);
  assert.match(restartBlock, /waitForSocket/);
  assert.doesNotMatch(restartBlock, /queryInstalledDaemonStatus/);
  assert.match(restartBlock, /installDaemonService\([\s\S]*activate:\s*false/);
  assert.equal(restartBlock.match(/installDaemonService\(/g)?.length, 1);
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

test("chat terminal backlog is reconciled without waiting for new ingress", () => {
  const chatMain = source("src/core/chat/main.ts");

  assert.match(chatMain, /requestReconcileChatTerminals\(\);/);
  assert.match(
    chatMain,
    /inboxPollTimer = setInterval\([\s\S]*requestReconcileChatInbox\(\);[\s\S]*requestReconcileChatTerminals\(\);/,
  );
  assert.match(
    chatMain,
    /listUnacknowledgedChatTerminalEvents\([\s\S]*reconcileChatTerminalEvents/,
  );
  assert.match(
    chatMain,
    /terminalRecord\?\.terminalId[\s\S]*terminal-reconcile:\$\{terminalId\}[\s\S]*affectChatBinding: false[\s\S]*recoverTerminals: false[\s\S]*projectAuthoritativeTerminal\(terminal\)/,
  );
});

test("chat lifecycle settlement is independent of restart and lease timing", () => {
  const chatMain = source("src/core/chat/main.ts");
  const inboxDrain = source("src/core/chat/inbox-drain.ts");
  const inbox = source("src/core/chat/inbox.ts");

  assert.doesNotMatch(inboxDrain, /preserveForRestart/);
  assert.doesNotMatch(chatMain, /preserveForRestart/);
  assert.doesNotMatch(chatMain, /preserveClaimedInboxJobForRestart/);
  assert.doesNotMatch(chatMain, /interruptProcessingChatInboxItems/);
  assert.match(
    chatMain,
    /chat turn detached without authoritative terminal[\s\S]*throw error;/,
  );
  assert.doesNotMatch(inbox, /lease_expired/);
});

test("chat snapshots inherited running jobs before adapters can claim new work", () => {
  const chatMain = source("src/core/chat/main.ts");
  const reconcile = chatMain.indexOf(
    "reconcileCommittedChatOutboxProcessing(runtime.agentDir)",
  );
  const snapshot = chatMain.indexOf(
    "const startupRecoverableProcessing = listRunningChatInboxItems",
    reconcile,
  );
  const recoveryFence = chatMain.indexOf(
    "app.beginInboundRecoveryChat(envelope.chatKey)",
    snapshot,
  );
  const adaptersStart = chatMain.indexOf("await app.start()", recoveryFence);
  const recoveryEnqueue = chatMain.indexOf(
    "for (const envelope of startupRecoverableProcessing)",
    adaptersStart,
  );
  const recoveryRelease = chatMain.indexOf(
    "app.completeInboundRecoveryChat(chatKey)",
  );

  assert.ok(reconcile >= 0);
  assert.ok(snapshot > reconcile);
  assert.ok(recoveryFence > snapshot);
  assert.ok(adaptersStart > recoveryFence);
  assert.ok(recoveryEnqueue > adaptersStart);
  assert.ok(recoveryRelease >= 0);
});

test("daemon restart preserves and resumes active durable turns", () => {
  const daemon = source("src/core/rin-daemon/daemon.ts");
  const workerPool = source("src/core/rin-daemon/worker-pool.ts");
  const shutdownBlock = workerPool.slice(
    workerPool.indexOf("async shutdown(graceMs: number)"),
    workerPool.indexOf("private updateWorkerMetadata"),
  );

  assert.doesNotMatch(daemon, /interruptActiveDaemonTurns/);
  assert.match(daemon, /await workerPool\.recoverActiveDaemonTurns\(\)/);
  assert.match(shutdownBlock, /this\.beginShutdown\(\)/);
  assert.match(shutdownBlock, /this\.destroyAll\(\)/);
  assert.match(workerPool, /preserveActiveTurn/);
  assert.match(workerPool, /resume_interrupted_turn/);
});
