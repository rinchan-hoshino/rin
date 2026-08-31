import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { parseJsonl } from "../rin-lib/common.js";
import { fail } from "../rin-lib/rpc-response.js";

const DEFAULT_ABORT_CONTROL_GRACE_MS = 250;
const DEFAULT_ABORT_SETTLE_GRACE_MS = 1_000;
const DEFAULT_EXECUTION_STARTUP_TIMEOUT_MS = 30_000;
const EXECUTION_STOP_GRACE_MS = 250;

type WorkerResourceOptions = Record<string, unknown> & {
  __rinInitialSession?:
    | { kind: "new"; parentSession?: unknown }
    | { kind: "managed"; managedSessionLeaf: string; parentSession?: unknown }
    | { kind: "open"; sessionFile: string };
};

type SupervisorStreams = {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
};

export type WorkerSupervisorOptions = Partial<SupervisorStreams> & {
  executionPath: string;
  abortGraceMs?: number;
  abortSettleGraceMs?: number;
  executionStartupTimeoutMs?: number;
  signal?: AbortSignal;
};

type ExecutionPlane = {
  child: ChildProcessWithoutNullStreams;
  generation: number;
  resourceDir: string;
  stdoutState: { buffer: string };
  retired: boolean;
  expectedExit: boolean;
  closed: Promise<void>;
  startupId?: string;
  resolveStartup?: () => void;
  rejectStartup?: (error: Error) => void;
};

type AbortAttempt = {
  id: string;
  execution: ExecutionPlane;
  resolveStarted: () => void;
  started: Promise<void>;
};

function positiveDuration(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function writeLine(output: Writable, payload: unknown) {
  output.write(`${JSON.stringify(payload)}\n`);
}

function resourceOptionsFile(options: WorkerResourceOptions) {
  const resourceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-session-execution-"),
  );
  fs.chmodSync(resourceDir, 0o700);
  const filePath = path.join(resourceDir, "resource-options.json");
  fs.writeFileSync(filePath, JSON.stringify(options), {
    encoding: "utf8",
    mode: 0o600,
  });
  return { resourceDir, filePath };
}

function sessionFileFromPayload(payload: any) {
  const direct = String(payload?.sessionFile || "").trim();
  if (direct) return direct;
  return String(payload?.data?.sessionFile || "").trim();
}

function requestTagFromPayload(payload: any) {
  return String(payload?.requestTag || "").trim();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runWorkerSupervisor(
  resourceOptions: WorkerResourceOptions = {},
  options: WorkerSupervisorOptions,
) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const abortGraceMs = positiveDuration(
    options.abortGraceMs,
    DEFAULT_ABORT_CONTROL_GRACE_MS,
  );
  const abortSettleGraceMs = positiveDuration(
    options.abortSettleGraceMs,
    DEFAULT_ABORT_SETTLE_GRACE_MS,
  );
  const executionStartupTimeoutMs = positiveDuration(
    options.executionStartupTimeoutMs,
    DEFAULT_EXECUTION_STARTUP_TIMEOUT_MS,
  );
  let executionGeneration = 0;
  let execution: ExecutionPlane | undefined;
  let sessionFile = "";
  let activeRequestTag = "";
  let abortAttempt: AbortAttempt | undefined;
  const nativeAbortsInFlight = new Set<string>();
  const nativeAbortTimers = new Map<string, NodeJS.Timeout>();
  const queuedAbortLines: string[] = [];
  let recoveringAbort:
    | { id: string; requestTag: string; queuedLines: string[] }
    | undefined;
  let stopping = false;
  let fatalError: unknown;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const cleanupResourceDir = (plane: ExecutionPlane) => {
    try {
      fs.rmSync(plane.resourceDir, { recursive: true, force: true });
    } catch {}
  };

  const writeExecutionLine = (plane: ExecutionPlane, line: string) => {
    if (
      plane.retired ||
      plane.child.exitCode !== null ||
      plane.child.signalCode !== null ||
      plane.child.stdin.destroyed ||
      plane.child.stdin.writableEnded
    ) {
      throw new Error("rin_execution_plane_stdin_unavailable");
    }
    plane.child.stdin.write(`${line}\n`);
  };

  const signalExecutionTree = (
    plane: ExecutionPlane,
    signal: NodeJS.Signals,
  ) => {
    if (process.platform !== "win32" && plane.child.pid) {
      try {
        process.kill(-plane.child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (plane.child.exitCode === null && plane.child.signalCode === null) {
      plane.child.kill(signal);
    }
  };

  const stopExecution = async (plane: ExecutionPlane | undefined) => {
    if (!plane) return;
    plane.expectedExit = true;
    plane.retired = true;
    signalExecutionTree(plane, "SIGTERM");
    await Promise.race([plane.closed, wait(EXECUTION_STOP_GRACE_MS)]);
    signalExecutionTree(plane, "SIGKILL");
    if (plane.child.exitCode === null && plane.child.signalCode === null) {
      await plane.closed;
    }
  };

  const clearNativeAbortTimer = (id: string) => {
    const timer = nativeAbortTimers.get(id);
    if (timer) clearTimeout(timer);
    nativeAbortTimers.delete(id);
  };

  const clearNativeAbortTimers = () => {
    for (const timer of nativeAbortTimers.values()) clearTimeout(timer);
    nativeAbortTimers.clear();
  };

  const flushQueuedAbortLines = () => {
    for (const line of queuedAbortLines.splice(0)) {
      void handleAbort(line, JSON.parse(line)).catch((error) => {
        writeLine(output, fail(undefined, "abort", error));
      });
    }
  };

  const armNativeAbortTimer = (id: string) => {
    clearNativeAbortTimer(id);
    const timer = setTimeout(() => {
      nativeAbortTimers.delete(id);
      if (!nativeAbortsInFlight.has(id) || recoveringAbort || stopping) return;
      void recoverBlockedAbort(id).catch((error) => {
        recoveringAbort = undefined;
        nativeAbortsInFlight.delete(id);
        writeLine(output, fail(id || undefined, "abort", error));
      });
    }, abortSettleGraceMs);
    timer.unref?.();
    nativeAbortTimers.set(id, timer);
  };

  const onExecutionPayload = (plane: ExecutionPlane, payload: any) => {
    if (plane.retired) return;
    const reportedSessionFile = sessionFileFromPayload(payload);
    if (reportedSessionFile) sessionFile = reportedSessionFile;
    if (
      payload?.type === "response" &&
      String(payload.id || "") === plane.startupId
    ) {
      if (payload.success === true) plane.resolveStartup?.();
      else {
        plane.rejectStartup?.(
          new Error(String(payload.error || "execution startup failed")),
        );
      }
      return;
    }
    if (
      payload?.type === "rpc_turn_event" &&
      (payload.event === "start" || payload.event === "heartbeat")
    ) {
      const requestTag = requestTagFromPayload(payload);
      if (requestTag) activeRequestTag = requestTag;
    }
    if (
      payload?.type === "rpc_turn_event" &&
      (payload.event === "complete" || payload.event === "error") &&
      requestTagFromPayload(payload) === activeRequestTag
    ) {
      activeRequestTag = "";
    }
    if (
      payload?.type === "rpc_control_event" &&
      payload.event === "abort_started"
    ) {
      const acknowledgedAbortId = String(payload.id || "");
      if (acknowledgedAbortId) {
        nativeAbortsInFlight.add(acknowledgedAbortId);
        armNativeAbortTimer(acknowledgedAbortId);
      }
      if (
        abortAttempt?.execution === plane &&
        acknowledgedAbortId === abortAttempt.id
      ) {
        const attempt = abortAttempt;
        abortAttempt = undefined;
        attempt.resolveStarted();
      }
      return;
    }
    if (
      payload?.type === "response" &&
      abortAttempt?.execution === plane &&
      String(payload.id || "") === abortAttempt.id
    ) {
      const attempt = abortAttempt;
      abortAttempt = undefined;
      attempt.resolveStarted();
    }
    const completedAbortId =
      payload?.type === "response" && payload.command === "abort"
        ? String(payload.id || "")
        : "";
    if (completedAbortId) {
      nativeAbortsInFlight.delete(completedAbortId);
      clearNativeAbortTimer(completedAbortId);
    }
    if (
      payload?.type === "response" &&
      recoveringAbort &&
      String(payload.id || "") === recoveringAbort.id &&
      (payload.command === "abort_interrupted_turn" ||
        payload.command === "abort")
    ) {
      payload = { ...payload, command: "abort" };
      const queuedLines = recoveringAbort.queuedLines;
      recoveringAbort = undefined;
      nativeAbortsInFlight.delete(String(payload.id || ""));
      clearNativeAbortTimer(String(payload.id || ""));
      writeLine(output, payload);
      for (const line of queuedLines) {
        const command = JSON.parse(line);
        if (command?.type === "abort") {
          void handleAbort(line, command).catch((error) => {
            writeLine(output, fail(command?.id, "abort", error));
          });
        } else {
          writeExecutionLine(plane, line);
        }
      }
      return;
    }
    writeLine(output, payload);
    if (completedAbortId) flushQueuedAbortLines();
  };

  const spawnExecution = async (nextOptions: WorkerResourceOptions) => {
    const { resourceDir, filePath } = resourceOptionsFile(nextOptions);
    const child = spawn(
      process.execPath,
      [
        options.executionPath,
        "--execution-plane",
        "--resource-options-file",
        filePath,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    let resolveClosed!: () => void;
    const plane: ExecutionPlane = {
      child,
      generation: ++executionGeneration,
      resourceDir,
      stdoutState: { buffer: "" },
      retired: false,
      expectedExit: false,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve;
      }),
    };
    execution = plane;
    child.stderr.on("data", (chunk) => {
      if (!plane.retired) errorOutput.write(chunk);
    });
    child.stdout.on("data", (chunk) => {
      parseJsonl(String(chunk), plane.stdoutState, (line) => {
        if (plane.retired) return;
        try {
          onExecutionPayload(plane, JSON.parse(line));
        } catch {
          output.write(`${line}\n`);
        }
      });
    });
    child.once("close", (_code, _signal) => {
      cleanupResourceDir(plane);
      resolveClosed();
      if (plane.expectedExit || stopping || plane !== execution) return;
      fatalError = new Error("rin_execution_plane_exit");
      resolveStopped();
    });

    const startupId = `rin_supervisor_state_${plane.generation}`;
    plane.startupId = startupId;
    const startup = new Promise<void>((resolve, reject) => {
      plane.resolveStartup = resolve;
      plane.rejectStartup = reject;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    writeExecutionLine(
      plane,
      JSON.stringify({ id: startupId, type: "get_state" }),
    );
    const timer = setTimeout(
      () =>
        plane.rejectStartup?.(new Error("rin_execution_plane_startup_timeout")),
      executionStartupTimeoutMs,
    );
    timer.unref?.();
    try {
      await startup;
    } finally {
      clearTimeout(timer);
      cleanupResourceDir(plane);
      plane.startupId = undefined;
      plane.resolveStartup = undefined;
      plane.rejectStartup = undefined;
    }
    return plane;
  };

  const recoverBlockedAbort = async (id: string) => {
    const previous = execution;
    if (!previous) throw new Error("rin_execution_plane_unavailable");
    if (!sessionFile) {
      throw new Error("rin_execution_plane_session_unknown");
    }
    const requestTag = activeRequestTag;
    recoveringAbort = {
      id,
      requestTag,
      queuedLines: queuedAbortLines.splice(0),
    };
    nativeAbortsInFlight.clear();
    clearNativeAbortTimers();
    previous.retired = true;
    previous.expectedExit = true;
    await stopExecution(previous);
    const replacement = await spawnExecution({
      ...resourceOptions,
      __rinInitialSession: { kind: "open", sessionFile },
    });
    const recoveryCommand = requestTag
      ? {
          id,
          type: "abort_interrupted_turn",
          requestTag,
        }
      : { id, type: "abort" };
    writeExecutionLine(replacement, JSON.stringify(recoveryCommand));
  };

  const handleAbort = async (line: string, command: any) => {
    const id = String(command?.id || "");
    const plane = execution!;
    if (abortAttempt?.execution === plane || nativeAbortsInFlight.size > 0) {
      queuedAbortLines.push(line);
      return;
    }
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    abortAttempt = { id, execution: plane, resolveStarted, started };
    writeExecutionLine(plane, line);
    const enteredNativeAbort = await Promise.race([
      started.then(() => true),
      wait(abortGraceMs).then(() => false),
    ]);
    if (enteredNativeAbort || plane.retired || execution !== plane) return;
    abortAttempt = undefined;
    try {
      await recoverBlockedAbort(id);
    } catch (error) {
      recoveringAbort = undefined;
      nativeAbortsInFlight.delete(id);
      clearNativeAbortTimer(id);
      writeLine(output, fail(id || undefined, "abort", error));
    }
  };

  const inputState = { buffer: "" };
  const onInputData = (chunk: Buffer | string) => {
    parseJsonl(String(chunk), inputState, (line) => {
      let command: any;
      try {
        command = JSON.parse(line);
      } catch (error) {
        writeLine(output, fail(undefined, "parse", error));
        return;
      }
      if (command?.type === "abort_interrupted_turn") {
        writeLine(
          output,
          fail(command?.id, command.type, "internal command is unavailable"),
        );
        return;
      }
      if (recoveringAbort) {
        recoveringAbort.queuedLines.push(line);
        return;
      }
      if (command?.type === "abort") {
        void handleAbort(line, command).catch((error) => {
          writeLine(output, fail(command?.id, "abort", error));
        });
        return;
      }
      try {
        if (!execution) throw new Error("rin_execution_plane_unavailable");
        writeExecutionLine(execution, line);
      } catch (error) {
        writeLine(output, fail(command?.id, command?.type || "unknown", error));
      }
    });
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearNativeAbortTimers();
    input.off("data", onInputData);
    input.pause();
    await stopExecution(execution);
    resolveStopped();
  };
  const onInputEnd = () => {
    void stop();
  };
  const onAbortSignal = () => {
    void stop();
  };

  try {
    await spawnExecution(resourceOptions);
    if (options.signal?.aborted) {
      await stop();
    } else {
      input.on("data", onInputData);
      input.once("end", onInputEnd);
      options.signal?.addEventListener("abort", onAbortSignal, { once: true });
      await stopped;
    }
    if (fatalError) throw fatalError;
  } finally {
    input.off("data", onInputData);
    input.off("end", onInputEnd);
    options.signal?.removeEventListener("abort", onAbortSignal);
    await stopExecution(execution);
  }
}
