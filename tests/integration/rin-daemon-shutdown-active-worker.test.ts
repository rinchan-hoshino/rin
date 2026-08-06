import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

async function waitForLine(socket, predicate, timeoutMs = 5000) {
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("line_timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (predicate(payload)) {
          cleanup();
          resolve(payload);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function withDaemon(workerScript, options, fn) {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-active-worker-stop-"),
  );
  await fs.writeFile(
    path.join(agentDir, "package.json"),
    '{"type":"module"}\n',
  );
  const socketPath = path.join(agentDir, "daemon.sock");
  const workerPath = path.join(agentDir, "fake-worker-source");
  await fs.writeFile(
    workerPath,
    workerScript.replace("__FAKE_STEP_MS__", String(options.stepMs ?? 0)),
  );
  const child = spawn(
    process.execPath,
    [
      path.join(rootDir, "dist", "core", "rin-daemon", "daemon.js"),
      socketPath,
      "--worker",
      workerPath,
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        RIN_DIR: agentDir,
      },
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
    await fn({
      agentDir,
      socketPath,
      child,
      stdoutRef: () => stdout,
      stderrRef: () => stderr,
    });
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const workerScript = `
import process from "node:process";
const timers = new Set();
function send(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const idx = buffer.indexOf("\\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "new_session") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session" } });
      continue;
    }
    if (command.type === "prompt") {
      send({ type: "rpc_turn_event", event: "start", turnGeneration: 1, requestTag: command.requestTag, sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session" });
      send({ type: "agent_start" });
      const delay = __FAKE_STEP_MS__;
      const timer = setTimeout(() => {
        timers.delete(timer);
        send({ type: "agent_end" });
        send({ type: "rpc_turn_event", event: "complete", turnGeneration: 1, requestTag: command.requestTag, sessionFile: "/tmp/fake-session.jsonl", sessionId: "fake-session", finalText: "done" });
        send({ type: "response", id: command.id, command: command.type, success: true });
      }, delay);
      timers.add(timer);
      continue;
    }
    send({ type: "response", id: command.id, command: command.type, success: true });
  }
});
`;

test("daemon exits without waiting for the current worker step", async () => {
  await withDaemon(
    workerScript,
    { stepMs: 3000 },
    async ({ socketPath, child, stdoutRef, stderrRef }) => {
      const socket = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(`${JSON.stringify({ id: "1", type: "new_session" })}\n`);
      await waitForLine(
        socket,
        (payload) => payload?.type === "response" && payload?.id === "1",
      );
      socket.write(
        `${JSON.stringify({ id: "2", type: "prompt", message: "hello", requestTag: "shutdown-turn" })}\n`,
      );
      await waitForLine(socket, (payload) => payload?.type === "agent_start");
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      const exited = new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      });
      child.kill("SIGTERM");
      const result = await exited;
      const elapsedMs = Date.now() - startedAt;

      assert.deepEqual(result, { code: 0, signal: null });
      assert.ok(elapsedMs < 1500, `elapsed=${elapsedMs}`);
      assert.match(stdoutRef(), /rin daemon listening/);
      assert.equal(stderrRef(), "");
    },
  );
});
