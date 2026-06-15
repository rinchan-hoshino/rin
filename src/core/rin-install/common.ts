import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { restoreTerminalCursor } from "./progress.js";

const FORWARDED_CHILD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
}

export function runCommand(command: string, args: string[], options: any = {}) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    let forwardedSignal: NodeJS.Signals | null = null;
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_CHILD_SIGNALS) {
      const handler = () => {
        forwardedSignal = signal;
        restoreTerminalCursor();
        if (!child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      restoreTerminalCursor();
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (forwardedSignal) return resolve(signalExitCode(forwardedSignal));
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
  });
}

export function detectCurrentUser() {
  const candidates = [
    process.env.SUDO_USER,
    process.env.LOGNAME,
    process.env.USER,
    (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "";
      }
    })(),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates[0] || "unknown";
}

export function repoRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}
