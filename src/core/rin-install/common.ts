import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { restoreTerminalCursor } from "./progress.js";
import {
  forwardChildSignals,
  signalExitCode,
} from "../platform/child-signals.js";
import { normalizeUserName } from "./users.js";

export function shouldRunCommandThroughShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(String(command || ""));
}

export function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
      shell:
        options.shell ??
        shouldRunCommandThroughShell(command, process.platform),
    });
    const forwarding = forwardChildSignals(child, {
      beforeForward: restoreTerminalCursor,
    });
    const cleanup = () => {
      forwarding.cleanup();
      restoreTerminalCursor();
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (forwarding.forwardedSignal) {
        return resolve(signalExitCode(forwarding.forwardedSignal));
      }
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
  });
}

export function detectCurrentUser() {
  const osUser = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "";
    }
  })();
  const candidates =
    process.platform === "win32"
      ? [process.env.USERNAME, osUser, process.env.LOGNAME, process.env.USER]
      : [process.env.SUDO_USER, process.env.LOGNAME, process.env.USER, osUser];
  return candidates.map(normalizeUserName).find(Boolean) || "unknown";
}

export function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}
