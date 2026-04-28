import {
  InteractiveMode,
  type InteractiveModeOptions,
} from "@mariozechner/pi-coding-agent";

import {
  applyRuntimeProfileEnvironment,
  createConfiguredAgentSession,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import {
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
  RIN_TUI_RUNTIME_ROLE_ENV,
} from "../tui-runtime-env.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";

import { RinDaemonFrontendClient } from "./rpc-client.js";
import { RpcInteractiveSession } from "./runtime.js";
import { createRpcRuntimeHost } from "./runtime-host.js";
import { applyRinTuiOverrides } from "./upstream-overrides.js";

type TuiInteractiveOptions = Pick<
  InteractiveModeOptions,
  "initialMessage" | "initialMessages" | "verbose"
>;
const RPC_TUI_STARTUP_CONNECT_ERROR_RE =
  /\bconnect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b/;
const RPC_TUI_STARTUP_TRANSIENT_ERROR_RE =
  /\b(?:rin_timeout|rin_disconnected|daemon_timeout):|\brin_tui_not_connected\b/;
const RPC_STARTUP_DAEMON_STATUS_TIMEOUT_MS = 5000;
const RPC_STARTUP_READY_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown) {
  return String((error as any)?.message || error || "").trim();
}

export function formatTuiStartupError(error: unknown) {
  const message = errorMessage(error);
  if (!message) return "rin_tui_failed";
  if (!RPC_TUI_STARTUP_CONNECT_ERROR_RE.test(message)) return message;
  return `RPC TUI could not connect to the daemon (${message}). Try \`rin doctor\` to inspect the daemon, or reopen Rin; the launcher will enter temporary maintenance mode if the daemon stays unavailable.`;
}

export function isRecoverableRpcStartupError(error: unknown) {
  const message = errorMessage(error);
  return (
    RPC_TUI_STARTUP_CONNECT_ERROR_RE.test(message) ||
    RPC_TUI_STARTUP_TRANSIENT_ERROR_RE.test(message)
  );
}

export function formatTuiMaintenanceFallbackNotice(error: unknown) {
  const message = errorMessage(error);
  const detail = message ? ` (${message})` : "";
  return `RPC TUI startup is unavailable${detail}. Entering temporary maintenance mode; run \`rin doctor\` if this keeps happening.`;
}

export async function withTuiStartupTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`rin_timeout:${label}`)),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForRpcStartupStep<T>(operation: Promise<T>, label: string) {
  return withTuiStartupTimeout(operation, RPC_STARTUP_READY_TIMEOUT_MS, label);
}

export async function isDaemonReadyForRpcStartup(
  options: { socketPath?: string; timeoutMs?: number } = {},
) {
  try {
    const status = await requestDaemonCommand(
      { type: "daemon_status" },
      {
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? RPC_STARTUP_DAEMON_STATUS_TIMEOUT_MS,
      },
    );
    return Boolean(status && typeof status === "object");
  } catch {
    return false;
  }
}

export async function shouldStartMaintenanceMode(
  options: {
    env?: NodeJS.ProcessEnv;
    socketPath?: string;
    timeoutMs?: number;
  } = {},
) {
  const env = options.env ?? process.env;
  const requestedRole = String(env[RIN_TUI_RUNTIME_ROLE_ENV] || "").trim();
  if (requestedRole === RIN_TUI_MAINTENANCE_ROLE) return true;
  return !(await isDaemonReadyForRpcStartup({
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs,
  }));
}

function startupProfiler() {
  const enabled = /^(1|true|yes)$/i.test(
    String(process.env.RIN_STARTUP_PROFILE || "").trim(),
  );
  const startedAt = Date.now();
  let lastAt = startedAt;
  return {
    mark(label: string) {
      if (!enabled) return;
      const now = Date.now();
      const delta = now - lastAt;
      const total = now - startedAt;
      lastAt = now;
      console.error(`[rin-startup] ${label} +${delta}ms total=${total}ms`);
    },
  };
}

export function resolveTuiInteractiveOptions(
  argv: string[],
): TuiInteractiveOptions {
  const messages: string[] = [];
  let passThroughMessages = false;
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (passThroughMessages) {
      messages.push(arg);
      continue;
    }
    if (arg === "--") {
      passThroughMessages = true;
      continue;
    }
    if (arg === "--verbose") {
      continue;
    }
    if (arg.startsWith("-")) continue;
    messages.push(arg);
  }

  return {
    initialMessage: messages[0],
    initialMessages: messages.length > 1 ? messages.slice(1) : undefined,
    verbose: argv.includes("--verbose") || undefined,
  };
}

export function shouldPrintStartupSeparator() {
  return true;
}

function applyTuiRuntimeRole(maintenanceMode: boolean) {
  process.env[RIN_TUI_RUNTIME_ROLE_ENV] = maintenanceMode
    ? RIN_TUI_MAINTENANCE_ROLE
    : RIN_TUI_RPC_FRONTEND_ROLE;
}

async function runInteractiveMode(
  runtime: ConstructorParameters<typeof InteractiveMode>[0],
  interactiveOptions: TuiInteractiveOptions,
) {
  const interactiveMode = new InteractiveMode(runtime, interactiveOptions);
  try {
    await interactiveMode.run();
  } catch (error) {
    interactiveMode.stop?.();
    throw error;
  }
}

async function startStdTui(
  options: { additionalExtensionPaths?: string[] },
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const { runtime: sessionRuntime } = await createConfiguredAgentSession({
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  profile.mark("maintenance-session-created");
  if (shouldPrintStartupSeparator()) {
    console.log();
  }
  await runInteractiveMode(sessionRuntime, interactiveOptions);
}

async function startRpcTui(
  options: { additionalExtensionPaths?: string[] },
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const client = new RinDaemonFrontendClient();
  const rpcSession = new RpcInteractiveSession(
    client,
    options.additionalExtensionPaths,
  );
  let runtimeHost: { dispose(): Promise<void> } | undefined;
  let interactiveMode: InteractiveMode | undefined;
  try {
    await rpcSession.prepareForInteractiveStartup();
    await waitForRpcStartupStep(rpcSession.connect(), "rpc_connect");
    await waitForRpcStartupStep(
      rpcSession.ensureSessionReady(),
      "rpc_session_ready",
    );
    runtimeHost = createRpcRuntimeHost(rpcSession);
    profile.mark("rpc-session-created");
    if (shouldPrintStartupSeparator()) {
      console.log();
    }
    interactiveMode = new InteractiveMode(
      runtimeHost as any,
      interactiveOptions,
    );
    await (interactiveMode as any).init();
    await (interactiveMode as any).rebindCurrentSession?.();
    (interactiveMode as any).renderCurrentSessionState?.();
    (interactiveMode as any).ui?.requestRender?.();
  } catch (error) {
    interactiveMode?.stop?.();
    if (runtimeHost) {
      await runtimeHost.dispose().catch(() => {});
    } else {
      await rpcSession.disconnect().catch(() => {});
    }
    throw new Error(formatTuiStartupError(error), { cause: error });
  }
  profile.mark("interactive-mode-and-rpc-ready");

  try {
    await interactiveMode.run();
  } catch (error) {
    interactiveMode.stop?.();
    throw error;
  } finally {
    await runtimeHost.dispose().catch(() => {});
  }
}

export async function startTui(
  options: { additionalExtensionPaths?: string[]; argv?: string[] } = {},
) {
  const profile = startupProfiler();
  const runtime = resolveRuntimeProfile();
  profile.mark("runtime-resolved");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) {
    process.chdir(runtime.cwd);
  }

  const argv = options.argv ?? process.argv.slice(2);
  const maintenanceMode = await shouldStartMaintenanceMode();
  applyTuiRuntimeRole(maintenanceMode);
  const interactiveOptions = resolveTuiInteractiveOptions(argv);
  profile.mark(maintenanceMode ? "mode=maintenance" : "mode=rpc");

  await applyRinTuiOverrides();

  if (maintenanceMode) {
    await startStdTui(options, profile, interactiveOptions);
    return;
  }

  try {
    await startRpcTui(options, profile, interactiveOptions);
  } catch (error) {
    if (!isRecoverableRpcStartupError(error)) throw error;
    console.error(formatTuiMaintenanceFallbackNotice(error));
    applyTuiRuntimeRole(true);
    profile.mark("mode=maintenance-after-rpc-startup-failure");
    await startStdTui(options, profile, interactiveOptions);
  }
}
