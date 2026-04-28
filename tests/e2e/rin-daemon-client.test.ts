import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const daemonClient = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "client.js"))
    .href
);

function runNodeEval(script) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", script],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
            }),
          );
          return;
        }
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

test("canConnectDaemonSocket reflects socket availability", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-client-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    assert.equal(
      await daemonClient.canConnectDaemonSocket(socketPath, 200),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  assert.equal(
    await daemonClient.canConnectDaemonSocket(socketPath, 200),
    false,
  );
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

test("requestDaemonCommand reuses the shared daemon JSONL client", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-client-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: "ignored",
            command: payload.type,
            success: true,
            data: { ok: false },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: { ok: true, echoedType: payload.type },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    const result = await daemonClient.requestDaemonCommand(
      { id: "doctor_1", type: "daemon_status" },
      { socketPath, timeoutMs: 500 },
    );
    assert.deepEqual(result, { ok: true, echoedType: "daemon_status" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, "doctor_1");
    assert.equal(requests[0].type, "daemon_status");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("daemon probe/status scripts share the same socket protocol", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-client-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        if (payload.type !== "daemon_status") continue;
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: { ok: true, source: "script" },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  try {
    await runNodeEval(
      daemonClient.buildDaemonSocketProbeScript(socketPath, 300),
    );

    const { stdout } = await runNodeEval(
      daemonClient.buildDaemonStatusScript(socketPath, 1500, "doctor_1"),
    );
    assert.deepEqual(JSON.parse(stdout), { ok: true, source: "script" });
    assert.equal(requests.at(-1)?.id, "doctor_1");
    assert.equal(requests.at(-1)?.type, "daemon_status");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("requestDaemonCommand surfaces invalid json and daemon errors distinctly", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-daemon-client-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const invalidJsonServer = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("not-json\n");
    });
  });
  await new Promise((resolve, reject) => {
    invalidJsonServer.once("error", reject);
    invalidJsonServer.listen(socketPath, () => resolve());
  });

  try {
    await assert.rejects(
      daemonClient.requestDaemonCommand(
        { type: "daemon_status" },
        { socketPath, timeoutMs: 500 },
      ),
      /daemon_invalid_json/,
    );
  } finally {
    await new Promise((resolve) => invalidJsonServer.close(() => resolve()));
  }

  const errorServer = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: false,
            error: "daemon_request_failed:test",
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    errorServer.once("error", reject);
    errorServer.listen(socketPath, () => resolve());
  });

  try {
    await assert.rejects(
      daemonClient.requestDaemonCommand(
        { type: "daemon_status" },
        { socketPath, timeoutMs: 500 },
      ),
      /daemon_request_failed:test/,
    );
  } finally {
    await new Promise((resolve) => errorServer.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
