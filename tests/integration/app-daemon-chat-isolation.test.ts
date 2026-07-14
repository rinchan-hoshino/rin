import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const database = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "database.js")).href
);
const daemonClient = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "client.js"))
    .href
);

async function waitForDegradedChat(socketPath: string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await daemonClient.requestDaemonCommand(
        { type: "daemon_status" },
        { socketPath, timeoutMs: 1_000 },
      );
      if (status?.chat?.status === "degraded") return status;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("daemon_chat_degraded_timeout");
}

test("app daemon stays available when the hosted chat service cannot start", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-chat-isolation-"),
  );
  const socketPath = path.join(agentDir, "daemon.sock");
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");
  const db = database.migrateChatDatabaseForInstall(agentDir);
  db.pragma("user_version = 3");
  database.closeChatDatabase(agentDir);

  const child = spawn(
    process.execPath,
    [path.join(rootDir, "dist", "app", "rin-daemon", "daemon.js"), socketPath],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
        RIN_DAEMON_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  try {
    const status = await waitForDegradedChat(socketPath);
    assert.equal(status.chat.ready, false);
    assert.match(
      status.chat.error,
      /chat_database_schema_upgrade_required:3:5/,
    );
    assert.equal(child.exitCode, null);
  } catch (error: any) {
    throw new Error(
      `${error?.message || error}\nstdout=${stdout}\nstderr=${stderr}`,
    );
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
