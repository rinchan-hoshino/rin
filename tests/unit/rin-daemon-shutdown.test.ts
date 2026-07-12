import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

async function waitForSocket(socketPath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      setTimeout(() => finish(false), 100);
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`socket_not_ready:${socketPath}`);
}

test("daemon shutdown stops hosted services before background extension wait", async () => {
  const daemonSource = await fs.readFile(
    path.join(rootDir, "src", "core", "rin-daemon", "daemon.ts"),
    "utf8",
  );
  const hostedStop = daemonSource.indexOf("options.onShutdown?.()");
  const backgroundStop = daemonSource.indexOf(
    "backgroundExtensionManager.stop",
  );
  assert.ok(hostedStop >= 0, "hosted shutdown hook missing");
  assert.ok(backgroundStop >= 0, "background extension stop missing");
  assert.ok(
    hostedStop < backgroundStop,
    "chat/hosted shutdown must run before background extension wait",
  );
  const appSource = await fs.readFile(
    path.join(rootDir, "src", "app", "rin-daemon", "daemon.ts"),
    "utf8",
  );
  assert.match(appSource, /onShutdown: stopHostedServices/);
  const hostedBody = new RegExp(
    String.raw`const stopHostedServices = async \(\) => \{([\s\S]*?)\n {2}\};`,
  ).exec(appSource)?.[1];
  assert.ok(hostedBody, "stopHostedServices missing");
  assert.equal(hostedBody.includes("backgroundExtensionManager"), false);
});

test("daemon bounds a hosted shutdown hook that never settles", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-hook-"));
  const socketPath = path.join(agentDir, "daemon.sock");
  const launcherPath = path.join(agentDir, "launcher.mjs");
  const daemonModuleUrl = pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"),
  ).href;
  await fs.writeFile(
    launcherPath,
    `import { startDaemon } from ${JSON.stringify(daemonModuleUrl)};\n` +
      `await startDaemon({ socketPath: ${JSON.stringify(socketPath)}, shutdownGraceMs: 250, onShutdown: async () => await new Promise(() => {}) });\n`,
  );
  const child = spawn(process.execPath, [launcherPath], {
    cwd: rootDir,
    env: { ...process.env, RIN_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForSocket(socketPath);
    const startedAt = Date.now();
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("daemon_exit_timeout")), 1500),
      ),
    ]);

    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(Date.now() - startedAt >= 200);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("daemon exits promptly on SIGTERM even with connected rpc clients", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-stop-"));
  const socketPath = path.join(agentDir, "daemon.sock");
  const child = spawn(
    process.execPath,
    [path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: { ...process.env, RIN_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForSocket(socketPath);
    const client = net.createConnection(socketPath);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });

    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });

    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("daemon_exit_timeout")), 3000),
      ),
    ]);

    assert.equal(
      result.code === 0 || result.signal === "SIGTERM",
      true,
      JSON.stringify(result),
    );
    assert.equal(client.destroyed, true);
  } catch (error) {
    throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
