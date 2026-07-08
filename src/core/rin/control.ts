import { sleep } from "../platform/process.js";
import {
  DEFAULT_DAEMON_DRAIN_TIMEOUT_MS,
  formatActiveDaemonWorkers,
  isDaemonChatQuiescing,
  waitForDaemonDrain,
} from "./daemon-drain.js";
import { tryManagedServiceAction } from "./managed-runtime-service.js";
export { readManagedRuntimeService } from "./managed-runtime-service.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  ParsedArgs,
} from "./shared.js";

async function waitForDaemonAvailable(
  context: ReturnType<typeof createTargetExecutionContext>,
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await context.canConnectSocket()) return true;
    await sleep(150);
  }
  return await context.canConnectSocket();
}

async function waitForDaemonUnavailable(
  context: ReturnType<typeof createTargetExecutionContext>,
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await context.canConnectSocket())) return true;
    await sleep(150);
  }
  return !(await context.canConnectSocket());
}

async function ensureLifecycleDaemonAvailable(
  context: ReturnType<typeof createTargetExecutionContext>,
) {
  if (await waitForDaemonAvailable(context)) return;
  await ensureDaemonAvailable(context);
}

function isLegacyPrepareUnsupportedError(error: unknown) {
  return String((error as any)?.message || error || "").includes(
    "rin_no_attached_session",
  );
}

export async function runStart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = await tryManagedServiceAction(context, "start");
  await ensureLifecycleDaemonAvailable(context);
  console.log(`rin start complete: ${unit}`);
}

export async function runStop(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = await tryManagedServiceAction(context, "stop");
  if (!(await waitForDaemonUnavailable(context))) {
    throw new Error(
      `rin_stop_incomplete: daemon socket is still reachable for ${context.targetUser}`,
    );
  }
  console.log(`rin stop complete: ${unit}`);
}

export async function runRestart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  let prepared = false;
  let restartActionStarted = false;
  let unit: string;
  try {
    const daemonRunning = await context.canConnectSocket();
    if (daemonRunning) {
      try {
        const preparedStatus = await context.prepareDaemonRestart();
        prepared = isDaemonChatQuiescing(preparedStatus);
      } catch (error: any) {
        const message = String(
          error?.message || error || "prepare did not complete",
        );
        if (!isLegacyPrepareUnsupportedError(error)) {
          throw new Error(`Restart prepare failed: ${message}`);
        }
      }
    }
    if (prepared) {
      const drain = await waitForDaemonDrain({
        queryStatus: context.queryDaemonStatus,
        timeoutMs: DEFAULT_DAEMON_DRAIN_TIMEOUT_MS,
        requireQuiescing: true,
      });
      if (!drain.drained) {
        throw new Error(
          drain.statusUnavailable || drain.quiesceUnavailable
            ? "Cannot restart yet: daemon status did not prove the daemon is quiesced and idle"
            : `Cannot restart yet: daemon still has active turns after ${DEFAULT_DAEMON_DRAIN_TIMEOUT_MS}ms: ${formatActiveDaemonWorkers(drain.activeWorkers)}`,
        );
      }
    }
    unit = await tryManagedServiceAction(context, "restart");
    restartActionStarted = true;
  } catch (error) {
    if (prepared && !restartActionStarted) {
      await context.cancelDaemonRestart().catch(() => {});
    }
    throw error;
  }
  await ensureLifecycleDaemonAvailable(context);
  console.log(`rin restart complete: ${unit!}`);
}
