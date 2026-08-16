import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { refreshPiSessionToolRegistry } from "../pi/session-host.js";
import { normalizeFrontendIdentity } from "../rin-lib/frontend-identity.js";
import { safeString } from "../text-utils.js";
import { canInvokeRuntimeSlashCommand } from "./catalog-helpers.js";
import {
  rpcDone as done,
  rpcRun as run,
  type RpcCommandRequest,
} from "./rpc-command-handler-context.js";
import type { RpcTurnCoordinator } from "./rpc-turn-coordinator.js";
import {
  getCommandArgumentCompletions,
  getResourceDiagnostics,
  getSlashCommands,
  runBuiltinCommand,
} from "./worker-helpers.js";

export function isWorkerLocalSessionReplacementCommand(commandLine: string) {
  const trimmed = safeString(commandLine).trim();
  if (trimmed === "/new") return true;
  if (!trimmed.startsWith("/resume ")) return false;
  return Boolean(trimmed.slice("/resume ".length).trim());
}

export type RpcResourceCommandContext = {
  getSession: () => AgentSession;
  turnCoordinator: Pick<RpcTurnCoordinator<unknown>, "assertAdmissionOpen">;
  createExtensionUiContext: () => unknown;
  SessionManager: unknown;
  runtime: unknown;
};

export function createRpcResourceCommandHandlers(
  context: RpcResourceCommandContext,
) {
  const {
    getSession,
    turnCoordinator,
    createExtensionUiContext,
    SessionManager,
    runtime,
  } = context;
  return {
    async get_resource_diagnostics({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, getResourceDiagnostics(session));
    },
    async get_command_argument_completions({
      command,
      id,
      type,
    }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        getCommandArgumentCompletions(
          session,
          safeString(command.commandName).trim(),
          safeString(command.argumentPrefix),
        ),
      );
    },
    async get_active_tools({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        tools: session.getActiveToolNames?.() || [],
      });
    },
    async get_all_tools({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        tools: session.getAllTools?.() || [],
      });
    },
    async set_active_tools({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const toolNames = Array.isArray(command.toolNames)
          ? command.toolNames
              .map((name: unknown) => safeString(name).trim())
              .filter(Boolean)
          : [];
        session.setActiveToolsByName?.(toolNames);
        return done(id, type, {
          tools: session.getActiveToolNames?.() || toolNames,
        });
      }
    },
    async refresh_tools({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      refreshPiSessionToolRegistry(session);
      return done(id, type, {
        tools: session.getAllTools?.() || [],
      });
    },
    async get_commands({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        commands: getSlashCommands(session),
      });
    },
    async run_command({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const commandLine = String(command.commandLine || "").trim();
        const commandName = commandLine.startsWith("/")
          ? commandLine.split(/\s+/, 1)[0]?.slice(1) || ""
          : "";
        return run(
          id,
          type,
          async () => {
            if (isWorkerLocalSessionReplacementCommand(commandLine)) {
              throw new Error(
                "session replacement commands must be routed through the frontend",
              );
            }
            const frontendKind =
              normalizeFrontendIdentity(command.frontendIdentity)?.kind ||
              "rpc";
            if (
              commandName &&
              !canInvokeRuntimeSlashCommand(
                getSlashCommands(session),
                commandName,
                frontendKind,
              )
            ) {
              return { handled: false };
            }
            const builtinResult = await runBuiltinCommand(
              runtime,
              commandLine,
              {
                SessionManager,
                uiContext: createExtensionUiContext(),
                promptContext: command.promptContext,
              },
            );
            if (builtinResult.handled) return builtinResult;
            if (
              commandName &&
              session.extensionRunner?.getCommand?.(commandName)
            ) {
              turnCoordinator.assertAdmissionOpen();
              await session.prompt(commandLine);
              return { handled: true };
            }
            return builtinResult;
          },
          (value) => value,
        );
      }
    },
  };
}

export type RpcResourceCommandHandlers = ReturnType<
  typeof createRpcResourceCommandHandlers
>;
