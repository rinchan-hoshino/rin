import {
  InteractiveMode,
  type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";

import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import {
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RPC_FRONTEND_ROLE,
  setRinTuiRuntimeRole,
  type RinTuiRuntimeRole,
} from "../tui-runtime-env.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import {
  formatRuntimeErrorForUser,
  rawErrorMessage,
} from "../rin-lib/user-facing-errors.js";

import { parseTuiCliOptions, type TuiResourceOptions } from "./cli-options.js";
import { RinDaemonFrontendClient } from "../rin-frontend-sdk/daemon-client.js";
import { TUI_FRONTEND_IDENTITY } from "../rin-frontend-sdk/frontend-identity.js";
import { createFrontendSdkRuntimeWrapper } from "../rin-frontend-sdk/runtime-wrapper.js";
import { RpcInteractiveSession } from "./runtime.js";
import { createRpcRuntimeHost } from "./runtime-host.js";
import { applyRinTuiOverrides } from "./upstream-overrides.js";

type TuiInteractiveOptions = Pick<
  InteractiveModeOptions,
  "initialMessage" | "initialMessages" | "verbose"
> & {
  rinStartupWarnings?: string[];
};

type StartTuiOptions = {
  additionalExtensionPaths?: string[];
  resourceOptions?: Partial<TuiResourceOptions>;
  argv?: string[];
};

type TuiStartupTerminal = {
  isTTY?: boolean;
  write?(value: string): unknown;
};

export function clearVisibleTerminalForTuiStartup(
  stdout: TuiStartupTerminal = process.stdout,
) {
  if (!stdout.isTTY || typeof stdout.write !== "function") return;
  stdout.write("\x1b[2J\x1b[H");
}
const RPC_TUI_STARTUP_CONNECT_ERROR_RE =
  /\bconnect (?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b/;
const RPC_TUI_STARTUP_TRANSIENT_ERROR_RE =
  /\b(?:rin_timeout|rin_disconnected|daemon_timeout):|\brin_tui_not_connected\b/;
const RPC_STARTUP_DAEMON_STATUS_TIMEOUT_MS = 5000;
const RPC_STARTUP_READY_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown) {
  return rawErrorMessage(error);
}

export function formatTuiStartupError(error: unknown) {
  const message = errorMessage(error);
  if (!message) return formatRuntimeErrorForUser("rin_tui_failed");
  if (!RPC_TUI_STARTUP_CONNECT_ERROR_RE.test(message)) {
    return formatRuntimeErrorForUser(message);
  }
  return `RPC TUI could not connect to the daemon (${message}). Try \`rin doctor\` to inspect the daemon, or reopen Rin; the launcher will enter temporary maintenance mode if the daemon stays unavailable.`;
}

export function isRecoverableRpcStartupError(error: unknown) {
  const message = errorMessage(error);
  return (
    RPC_TUI_STARTUP_CONNECT_ERROR_RE.test(message) ||
    RPC_TUI_STARTUP_TRANSIENT_ERROR_RE.test(message)
  );
}

export function formatTuiMaintenanceModeNotice() {
  return [
    "Rin daemon is unavailable.",
    "Entering temporary maintenance mode.",
    "Some features may be unavailable or not match daemon/RPC behavior.",
  ].join("\n");
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
    requestedRole?: RinTuiRuntimeRole;
    socketPath?: string;
    timeoutMs?: number;
  } = {},
) {
  if (options.requestedRole === RIN_TUI_MAINTENANCE_ROLE) return true;
  return !(await isDaemonReadyForRpcStartup({
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs,
  }));
}

function startupProfiler() {
  return {
    mark(_label: string) {},
  };
}

export function resolveTuiInteractiveOptions(
  argv: string[],
): TuiInteractiveOptions {
  const parsed = parseTuiCliOptions(argv);
  return {
    initialMessage: parsed.initialMessage,
    initialMessages: parsed.initialMessages,
    verbose: parsed.verbose,
  };
}

export function applyQuietStartupVersionCheckEnv(
  settingsManager: { getQuietStartup?: () => boolean } | undefined,
  interactiveOptions: TuiInteractiveOptions,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (interactiveOptions.verbose) return;
  if (settingsManager?.getQuietStartup?.() === true) {
    env.RIN_SKIP_VERSION_CHECK ||= "1";
  }
}

function applyTuiRuntimeRole(maintenanceMode: boolean) {
  setRinTuiRuntimeRole(
    maintenanceMode ? RIN_TUI_MAINTENANCE_ROLE : RIN_TUI_RPC_FRONTEND_ROLE,
  );
}

export async function prepareRpcSessionWorkerForInteractiveStartup(
  rpcSession: Pick<
    RpcInteractiveSession,
    | "prepareForInteractiveStartup"
    | "connect"
    | "ensureSessionReady"
    | "settingsManager"
  >,
  interactiveOptions: TuiInteractiveOptions,
  profile: Pick<ReturnType<typeof startupProfiler>, "mark">,
) {
  await rpcSession.prepareForInteractiveStartup();
  applyQuietStartupVersionCheckEnv(
    rpcSession.settingsManager,
    interactiveOptions,
  );
  await waitForRpcStartupStep(rpcSession.connect(), "rpc_connect");
  await waitForRpcStartupStep(
    rpcSession.ensureSessionReady(),
    "rpc_session_ready",
  );
  profile.mark("rpc-session-created");
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

export async function initializeRpcInteractiveModeForStartup(
  interactiveMode: InteractiveMode,
  _rpcSession: RpcInteractiveSession,
) {
  await (interactiveMode as any).init();
}

export async function runPreinitializedInteractiveMode(
  interactiveMode: InteractiveMode,
) {
  const mode = interactiveMode as any;
  const originalInit = mode.init;
  mode.init = async () => {};
  try {
    await mode.run();
  } finally {
    mode.init = originalInit;
  }
}

async function startStdTui(
  resourceOptions: Partial<TuiResourceOptions>,
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const { createConfiguredAgentSession } =
    await import("../rin-lib/runtime.js");
  const { runtime: sessionRuntime } = await createConfiguredAgentSession({
    additionalExtensionPaths: resourceOptions.additionalExtensionPaths,
    noExtensions: resourceOptions.noExtensions,
    extensionFlagValues: resourceOptions.extensionFlagValues,
    additionalSkillPaths: resourceOptions.additionalSkillPaths,
    noSkills: resourceOptions.noSkills,
    additionalPromptTemplatePaths:
      resourceOptions.additionalPromptTemplatePaths,
    noPromptTemplates: resourceOptions.noPromptTemplates,
    additionalThemePaths: resourceOptions.additionalThemePaths,
    noThemes: resourceOptions.noThemes,
    noContextFiles: resourceOptions.noContextFiles,
    systemPrompt: resourceOptions.systemPrompt,
    appendSystemPrompt: resourceOptions.appendSystemPrompt,
  });
  profile.mark("maintenance-session-created");
  applyQuietStartupVersionCheckEnv(
    (sessionRuntime as any)?.session?.settingsManager,
    interactiveOptions,
  );
  clearVisibleTerminalForTuiStartup();
  await runInteractiveMode(
    createFrontendSdkRuntimeWrapper(sessionRuntime),
    interactiveOptions,
  );
}

async function startMaintenanceTui(
  resourceOptions: Partial<TuiResourceOptions>,
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
  startupWarning: string = formatTuiMaintenanceModeNotice(),
) {
  await startStdTui(resourceOptions, profile, {
    ...interactiveOptions,
    rinStartupWarnings: [startupWarning],
  });
}

async function startRpcTui(
  resourceOptions: Partial<TuiResourceOptions>,
  profile: ReturnType<typeof startupProfiler>,
  interactiveOptions: TuiInteractiveOptions,
) {
  const client = new RinDaemonFrontendClient({
    frontendIdentity: TUI_FRONTEND_IDENTITY,
  });
  const rpcSession = new RpcInteractiveSession(client, resourceOptions);
  let runtimeHost: { dispose(): Promise<void> } | undefined;
  let interactiveMode: InteractiveMode | undefined;
  try {
    await prepareRpcSessionWorkerForInteractiveStartup(
      rpcSession,
      interactiveOptions,
      profile,
    );
    runtimeHost = createFrontendSdkRuntimeWrapper(
      createRpcRuntimeHost(rpcSession),
    );
    clearVisibleTerminalForTuiStartup();
    interactiveMode = new InteractiveMode(
      runtimeHost as any,
      interactiveOptions,
    );
    await initializeRpcInteractiveModeForStartup(interactiveMode, rpcSession);
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
    await runPreinitializedInteractiveMode(interactiveMode);
  } catch (error) {
    interactiveMode.stop?.();
    throw error;
  } finally {
    await runtimeHost.dispose().catch(() => {});
  }
}

export async function startTui(options: StartTuiOptions = {}) {
  const profile = startupProfiler();
  const runtime = resolveRuntimeProfile();
  profile.mark("runtime-resolved");
  applyRuntimeProfileEnvironment(runtime);
  if (process.cwd() !== runtime.cwd) {
    process.chdir(runtime.cwd);
  }

  const argv = options.argv ?? process.argv.slice(2);
  const parsedTuiOptions = parseTuiCliOptions(argv, runtime.cwd);
  const resourceOptions: Partial<TuiResourceOptions> = {
    ...parsedTuiOptions.resources,
    ...options.resourceOptions,
    additionalExtensionPaths:
      options.resourceOptions?.additionalExtensionPaths ??
      options.additionalExtensionPaths ??
      parsedTuiOptions.resources.additionalExtensionPaths,
  };
  const maintenanceMode = await shouldStartMaintenanceMode();
  applyTuiRuntimeRole(maintenanceMode);
  const interactiveOptions: TuiInteractiveOptions = {
    initialMessage: parsedTuiOptions.initialMessage,
    initialMessages: parsedTuiOptions.initialMessages,
    verbose: parsedTuiOptions.verbose,
  };
  profile.mark(maintenanceMode ? "mode=maintenance" : "mode=rpc");

  await applyRinTuiOverrides();

  if (maintenanceMode) {
    await startMaintenanceTui(resourceOptions, profile, interactiveOptions);
    return;
  }

  try {
    await startRpcTui(resourceOptions, profile, interactiveOptions);
  } catch (error) {
    if (!isRecoverableRpcStartupError(error)) throw error;
    applyTuiRuntimeRole(true);
    profile.mark("mode=maintenance-after-rpc-startup-failure");
    await startMaintenanceTui(
      resourceOptions,
      profile,
      interactiveOptions,
      formatTuiMaintenanceFallbackNotice(error),
    );
  }
}
