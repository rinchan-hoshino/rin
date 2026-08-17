import "./require-test-sandbox.ts";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function liveSocketPath(runtimeDir: string | undefined) {
  if (runtimeDir) return path.join(runtimeDir, "rin-daemon", "daemon.sock");
  if (process.platform === "linux" && typeof process.getuid === "function") {
    return path.join(
      "/run/user",
      String(process.getuid()),
      "rin-daemon",
      "daemon.sock",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Caches",
      "rin-daemon",
      "daemon.sock",
    );
  }
  return path.join(os.homedir(), ".cache", "rin-daemon", "daemon.sock");
}

export function createSocketTestSandbox(label: string) {
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rin-${label}-socket-`));
  const runtimeDir = path.join(root, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDir, 0o700);
  const resolvedRoot = path.resolve(root);
  const capturedLiveSocketPath = path.resolve(
    liveSocketPath(previousRuntimeDir),
  );
  let cleaned = false;

  process.env.XDG_RUNTIME_DIR = runtimeDir;

  function assertOwnedSocketPath(socketPath: string) {
    const candidate = path.resolve(socketPath);
    if (
      candidate === capturedLiveSocketPath ||
      !candidate.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new Error(`test_socket_path_outside_sandbox:${candidate}`);
    }

    let current = path.dirname(candidate);
    while (current !== resolvedRoot) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error(`test_socket_path_symlink_escape:${candidate}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      current = path.dirname(current);
    }
    return candidate;
  }

  return {
    root,
    runtimeDir,
    liveSocketPath: capturedLiveSocketPath,
    assertOwnedSocketPath,
    async removeOwnedSocket(socketPath: string) {
      await fsp.rm(assertOwnedSocketPath(socketPath), { force: true });
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
