import { spawnSync } from "node:child_process";
import { shellQuote } from "../rin-lib/system.js";
import { safeString } from "../text-utils.js";
import {
  isSupportedTargetRecord,
  type RinTargetRecord,
  type RinRuntimeTransport,
} from "./registry.js";
import { findTarget } from "./store.js";

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
  return explicit ? findTarget(explicit) : undefined;
}

function commandForTransport(
  transport: RinRuntimeTransport,
  rinArgs: string[],
  io: { stdinIsTTY: boolean; stdoutIsTTY: boolean },
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
    if (io.stdinIsTTY && io.stdoutIsTTY) args.push("-t");
    if (transport.port) args.push("-p", String(transport.port));
    if (transport.identityFile) args.push("-i", transport.identityFile);
    if (transport.controlPath)
      args.push("-o", `ControlPath=${transport.controlPath}`);
    const remoteCommand = [
      'exec "$HOME/.rin/runtime/node/current/bin/node" "$HOME/.rin/app/current/dist/app/rin/main.js"',
      ...rinArgs.map(shellQuote),
    ].join(" ");
    args.push("--", target, remoteCommand);
    return { command: "ssh", args };
  }
  if (transport.kind === "container") {
    const args = ["exec"];
    if (io.stdinIsTTY) args.push("-i");
    if (io.stdoutIsTTY) args.push("-t");
    if (transport.user) args.push("-u", transport.user);
    const installDir = transport.installDir || "/root/.rin";
    args.push(
      transport.container,
      `${installDir}/runtime/node/current/bin/node`,
      `${installDir}/app/current/dist/app/rin/main.js`,
      ...rinArgs,
    );
    return { command: transport.engine, args };
  }
  throw new Error(
    `rin_target_unsupported:${safeString((transport as any)?.kind)}`,
  );
}

export function runRinOnTarget(
  target: RinTargetRecord,
  rawArgv: string[],
  io: { stdinIsTTY?: boolean; stdoutIsTTY?: boolean } = {},
) {
  if (!isSupportedTargetRecord(target)) {
    throw new Error(
      `rin_target_unsupported:${safeString((target as any)?.kind)}`,
    );
  }
  const rinArgs = stripTargetWrapperArgs(rawArgv);
  const { command, args } = commandForTransport(target.runtime, rinArgs, {
    stdinIsTTY: io.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: io.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
  });
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return typeof result.status === "number" ? result.status : 1;
}
