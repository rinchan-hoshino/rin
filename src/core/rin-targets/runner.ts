import { spawnSync } from "node:child_process";
import { safeString } from "../text-utils.js";
import type { RinTargetRecord, RinRuntimeTransport } from "./registry.js";
import { findTarget, getDefaultTarget } from "./store.js";

const TARGET_FLAGS_WITH_VALUE = new Set(["--target"]);

export function stripTargetWrapperArgs(rawArgv: string[]) {
  const args: string[] = [];
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = safeString(rawArgv[index]).trim();
    if (!arg) continue;
    if (TARGET_FLAGS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) continue;
    args.push(arg);
  }
  return args;
}

export function resolveTargetForName(name: string) {
  const explicit = safeString(name).trim();
  return explicit ? findTarget(explicit) : getDefaultTarget();
}

function commandForTransport(
  transport: RinRuntimeTransport,
  rinArgs: string[],
) {
  if (transport.kind === "local-user") {
    return {
      command: process.execPath,
      args: [process.argv[1], "--user", transport.user, ...rinArgs],
    };
  }
  if (transport.kind === "ssh") {
    const target = transport.user
      ? `${transport.user}@${transport.host}`
      : transport.host;
    const args = [] as string[];
    if (transport.port) args.push("-p", String(transport.port));
    if (transport.identityFile) args.push("-i", transport.identityFile);
    if (transport.controlPath)
      args.push("-o", `ControlPath=${transport.controlPath}`);
    args.push(target, "rin", ...rinArgs);
    return { command: "ssh", args };
  }
  if (transport.kind === "command") {
    return {
      command: transport.command,
      args: [...transport.argsBeforeRin, "rin", ...rinArgs],
    };
  }
  const args = ["exec"];
  if (transport.user) args.push("-u", transport.user);
  args.push(transport.container, "rin", ...rinArgs);
  return { command: transport.engine, args };
}

export function runRinOnTarget(target: RinTargetRecord, rawArgv: string[]) {
  const rinArgs = stripTargetWrapperArgs(rawArgv);
  const { command, args } = commandForTransport(target.runtime, rinArgs);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return typeof result.status === "number" ? result.status : 1;
}
