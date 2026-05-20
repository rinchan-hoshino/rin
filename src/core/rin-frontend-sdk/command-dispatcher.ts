import { isDaemonBuiltinSlashCommand } from "../rin-lib/rpc.js";
import { safeString } from "../text-utils.js";
import {
  frontendCommandNameFromLine,
  parseFrontendCompactCommand,
} from "./command-responses.js";

export type RinFrontendCommandRouteKind = "none" | "frontend" | "daemon";

export type RinFrontendCommandRoute = {
  kind: RinFrontendCommandRouteKind;
  name: string;
};

export type RinFrontendCommandCatalogItem = {
  name?: unknown;
  source?: unknown;
};

export type RinFrontendCommandSpec = {
  name: string;
  match: (commandLine: string) => boolean;
};

export const RIN_FRONTEND_SESSION_COMMANDS: RinFrontendCommandSpec[] = [
  {
    name: "abort",
    match: (commandLine) => safeString(commandLine).trim() === "/abort",
  },
  {
    name: "new",
    match: (commandLine) => safeString(commandLine).trim() === "/new",
  },
  {
    name: "compact",
    match: (commandLine) => parseFrontendCompactCommand(commandLine).compact,
  },
  {
    name: "resume",
    match: (commandLine) => {
      const trimmed = safeString(commandLine).trim();
      if (!trimmed.startsWith("/resume ")) return false;
      return trimmed.slice("/resume ".length).trim().length > 0;
    },
  },
];

export function getRinFrontendSessionCommandSpec(commandLine: string) {
  const name = frontendCommandNameFromLine(commandLine);
  if (!name) return undefined;
  return RIN_FRONTEND_SESSION_COMMANDS.find(
    (command) => command.name === name && command.match(commandLine),
  );
}

export function isFrontendSessionCommandLine(commandLine: string) {
  return Boolean(getRinFrontendSessionCommandSpec(commandLine));
}

export type RinNonInteractiveCommandInteractionPolicy = {
  skipSessionRecovery: boolean;
  acceptInboundBeforeExecution: boolean;
};

export const RIN_NON_INTERACTIVE_COMMAND_NAMES = [
  "help",
  "abort",
  "new",
  "compact",
  "reload",
  "status",
  "session",
  "model",
] as const;

const RIN_NON_INTERACTIVE_COMMAND_NAME_SET = new Set<string>(
  RIN_NON_INTERACTIVE_COMMAND_NAMES,
);
const CLI_SKIP_SESSION_RECOVERY_COMMANDS = new Set(["new"]);
const CLI_ACCEPT_BEFORE_EXECUTION_COMMANDS = new Set([
  "abort",
  "new",
  "compact",
  "reload",
]);

export function isRinNonInteractiveCommandExposed(commandName: unknown) {
  const nextName = safeString(commandName).trim().replace(/^\//, "");
  return RIN_NON_INTERACTIVE_COMMAND_NAME_SET.has(nextName);
}

export function getRinNonInteractiveCommandInteractionPolicy(
  commandName: unknown,
): RinNonInteractiveCommandInteractionPolicy {
  const nextName = safeString(commandName).trim().replace(/^\//, "");
  return {
    skipSessionRecovery: CLI_SKIP_SESSION_RECOVERY_COMMANDS.has(nextName),
    acceptInboundBeforeExecution:
      CLI_ACCEPT_BEFORE_EXECUTION_COMMANDS.has(nextName),
  };
}

export function classifyRinFrontendCommand(
  commandLine: string,
  catalog: RinFrontendCommandCatalogItem[] = [],
): RinFrontendCommandRoute {
  const name = frontendCommandNameFromLine(commandLine);
  if (!name) return { kind: "none", name: "" };
  if (isFrontendSessionCommandLine(commandLine)) {
    return { kind: "frontend", name };
  }
  if (isDaemonBuiltinSlashCommand(name)) return { kind: "daemon", name };
  const catalogMatch = catalog.some(
    (command) =>
      safeString(command?.name).trim() === name &&
      safeString(command?.source).trim() === "extension",
  );
  return catalogMatch ? { kind: "daemon", name } : { kind: "none", name };
}
