import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { buildUserShell, targetUserRuntimeEnv } from "../rin-lib/system.js";

const HOLDER_READY_TIMEOUT_MS = 10_000;
const HOLDER_RELEASE_TIMEOUT_MS = 5_000;

const HOLDER_SCRIPT = String.raw`
import { pathToFileURL } from "node:url";
const [lockModulePath, acquireName, agentDir, socketPath] = process.argv.slice(1);
const lockModule = await import(pathToFileURL(lockModulePath).href);
const acquire = lockModule[acquireName];
if (typeof acquire !== "function") throw new Error("rin_update_fence_holder_acquire_missing");
const fence = await acquire(agentDir, { socketPath });
process.stdout.write(JSON.stringify({ event: "ready", owner: fence.owner }) + "\n");
let released = false;
const release = async (code = 0) => {
  if (released) return;
  released = true;
  try {
    await fence.release();
    process.exit(code);
  } catch (error) {
    process.stderr.write(String(error?.stack || error) + "\n");
    process.exit(1);
  }
};
process.stdin.resume();
process.stdin.on("end", () => void release(0));
process.on("SIGINT", () => void release(130));
process.on("SIGTERM", () => void release(143));
`;

export interface TargetDaemonHeldLock {
  owner: {
    pid: number;
    token: string;
    createdAt: string;
    processStartTime?: string;
    purpose?: string;
  };
  release(): Promise<void>;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("rin_update_fence_holder_exit_timeout"));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function waitForConfirmedExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function terminateHolder(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.stdin.end();
  try {
    await waitForExit(child, HOLDER_RELEASE_TIMEOUT_MS);
  } catch {
    child.kill("SIGTERM");
    try {
      await waitForExit(child, HOLDER_RELEASE_TIMEOUT_MS);
    } catch {
      child.kill("SIGKILL");
      // Never report release while the target-user process may still own the
      // kernel lease. After an unconditional kill, wait without a deadline;
      // returning a live lease would be less recoverable than waiting.
      await waitForConfirmedExit(child);
    }
  }
}

async function acquireTargetDaemonHeldLock(
  options: {
    targetUser: string;
    nodePath: string;
    lockModulePath: string;
    acquireName: "acquireDaemonMigrationLock" | "acquireDaemonUpdateFence";
    agentDir: string;
    socketPath: string;
  },
  recoverAbnormalRelease = true,
  failStopOnUnexpectedExit = true,
): Promise<TargetDaemonHeldLock> {
  const launch = buildUserShell(
    options.targetUser,
    [
      options.nodePath,
      "--input-type=module",
      "-e",
      HOLDER_SCRIPT,
      options.lockModulePath,
      options.acquireName,
      options.agentDir,
      options.socketPath,
    ],
    targetUserRuntimeEnv(options.targetUser),
  );
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const owner = await new Promise<TargetDaemonHeldLock["owner"]>(
      (resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("rin_update_fence_holder_ready_timeout"));
        }, HOLDER_READY_TIMEOUT_MS);
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          child.off("error", onError);
        };
        const onData = (chunk: Buffer | string) => {
          stdout += chunk.toString();
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          cleanup();
          try {
            const message = JSON.parse(stdout.slice(0, newline));
            if (message?.event !== "ready" || !message?.owner?.token) {
              throw new Error("rin_update_fence_holder_invalid_ready");
            }
            resolve(message.owner);
          } catch (error) {
            reject(error);
          }
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(
            new Error(
              `rin_update_fence_holder_exited: code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderr.trim()}`,
            ),
          );
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
        child.once("error", onError);
      },
    );

    let releaseStarted = false;
    let holderStopped = false;
    let released = false;
    const failStopUpdater = () => {
      if (releaseStarted || !failStopOnUnexpectedExit) return;
      const message =
        `rin_update_fence_holder_lost: purpose=${owner.purpose} ` +
        `code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"} ` +
        `stderr=${stderr.trim()}`;
      process.stderr.write(`${message}\n`);
      // The child was the kernel-lease owner. Continuing even one mutation
      // step would be unsafe, and promises cannot cancel an in-flight
      // filesystem migration. Process teardown also closes every other holder
      // pipe, so fail-stop is the recoverable ownership boundary.
      process.exit(70);
    };
    child.once("exit", failStopUpdater);
    if (child.exitCode != null || child.signalCode != null) {
      failStopUpdater();
    }
    return {
      owner,
      async release() {
        if (released) return;
        releaseStarted = true;
        if (!holderStopped) {
          await terminateHolder(child);
          holderStopped = true;
        }
        const abnormalExit =
          (child.exitCode !== 0 && child.exitCode != null) ||
          child.signalCode != null;
        if (abnormalExit) {
          if (!recoverAbnormalRelease) {
            throw new Error(
              `rin_update_fence_holder_release_failed: code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"} stderr=${stderr.trim()}`,
            );
          }
          // The dead child no longer owns its kernel lease, but it may have
          // failed before removing the systemd-visible marker. A fresh target-
          // user holder atomically reclaims that stale marker and releases it.
          // If cleanup itself fails, leave this handle retryable.
          const cleanup = await acquireTargetDaemonHeldLock(
            options,
            false,
            false,
          );
          await cleanup.release();
        }
        released = true;
      },
    };
  } catch (error) {
    await terminateHolder(child);
    throw error;
  }
}

export async function acquireTargetDaemonUpdateFence(options: {
  targetUser: string;
  nodePath: string;
  lockModulePath: string;
  agentDir: string;
  socketPath: string;
}) {
  return await acquireTargetDaemonHeldLock({
    ...options,
    acquireName: "acquireDaemonUpdateFence",
  });
}

export async function acquireTargetDaemonMigrationLock(options: {
  targetUser: string;
  nodePath: string;
  lockModulePath: string;
  agentDir: string;
  socketPath: string;
}) {
  return await acquireTargetDaemonHeldLock({
    ...options,
    acquireName: "acquireDaemonMigrationLock",
  });
}
