import fs from "node:fs";

const TERMINAL_RESTORE_SEQUENCE = "\x1b[?25h\x1b[0m\x1b[?2004l\x1b[?1049l";

let fatalTerminalResetInstalled = false;
let terminalRestoredForExit = false;

function writeSync(stream: NodeJS.WriteStream, value: string) {
  try {
    const fd = (stream as any).fd;
    if (typeof fd === "number") {
      fs.writeSync(fd, value);
      return;
    }
    stream.write(value);
  } catch {
    // Best effort only: fatal-exit cleanup must not mask the original error.
  }
}

export function restoreTerminalStateForExit(
  streams: {
    stdin?: NodeJS.ReadStream | undefined;
    stdout?: NodeJS.WriteStream | undefined;
    stderr?: NodeJS.WriteStream | undefined;
  } = {},
) {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;

  if (terminalRestoredForExit) return;
  terminalRestoredForExit = true;

  try {
    if (stdin?.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(false);
    }
  } catch {
    // Best effort only: leave the real crash/error visible.
  }

  if (stdout?.isTTY) {
    writeSync(stdout, TERMINAL_RESTORE_SEQUENCE);
  } else if (stderr?.isTTY) {
    writeSync(stderr, TERMINAL_RESTORE_SEQUENCE);
  }
}

function reportFatalError(error: unknown) {
  const message = String((error as any)?.stack || error || "rin_tui_failed");
  console.error(message);
}

export function installTuiFatalTerminalReset() {
  if (fatalTerminalResetInstalled) return;
  fatalTerminalResetInstalled = true;

  process.once("exit", () => {
    restoreTerminalStateForExit();
  });
  process.once("uncaughtException", (error) => {
    restoreTerminalStateForExit();
    reportFatalError(error);
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    restoreTerminalStateForExit();
    reportFatalError(reason);
    process.exit(1);
  });
}

export function resetTerminalCleanupForTests() {
  terminalRestoredForExit = false;
}
