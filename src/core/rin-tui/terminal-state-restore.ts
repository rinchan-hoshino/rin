import fs from "node:fs";

const TERMINAL_RESTORE_SEQUENCE =
  "\x1b]9;4;0;\x07\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[0m";

let terminalStateRestoreInstalled = false;
let terminalRestoredForExit = false;
let initialRawMode: boolean | undefined;

function writeSync(stream: NodeJS.WriteStream, value: string) {
  try {
    const fd = (stream as any).fd;
    if (typeof fd === "number") {
      fs.writeSync(fd, value);
      return;
    }
    stream.write(value);
  } catch {
    // Best effort only: exit cleanup must not mask the original error.
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
      stdin.setRawMode(initialRawMode ?? false);
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

function reportTerminalCrash(error: unknown) {
  const message = String((error as any)?.stack || error || "rin_tui_failed");
  console.error(message);
}

export function installTuiTerminalStateRestore(
  streams: { stdin?: NodeJS.ReadStream | undefined } = {},
) {
  if (terminalStateRestoreInstalled) return;
  terminalStateRestoreInstalled = true;
  initialRawMode = Boolean((streams.stdin ?? process.stdin)?.isRaw);

  process.once("exit", () => {
    restoreTerminalStateForExit();
  });
  process.once("uncaughtException", (error) => {
    restoreTerminalStateForExit();
    reportTerminalCrash(error);
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    restoreTerminalStateForExit();
    reportTerminalCrash(reason);
    process.exit(1);
  });
}

export function resetTerminalStateRestoreForTests() {
  terminalRestoredForExit = false;
  terminalStateRestoreInstalled = false;
  initialRawMode = undefined;
}
