import { sleep } from "../platform/process.js";
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
  const unit = await tryManagedServiceAction(context, "restart");
  if (!(await waitForDaemonAvailable(context, 30_000))) {
    throw new Error(
      `rin_daemon_restart_not_ready: daemon socket did not become reachable for ${context.targetUser}`,
    );
  }
  console.log(`rin restart complete: ${unit}`);
}
