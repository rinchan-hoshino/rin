import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const client = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/client.js")
>("dist/core/rin-daemon/client.js");

function runScript(script: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        ["-e", script],
        { encoding: "utf8" },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(error);
            return;
          }
          resolve({
            code: error && typeof error.code === "number" ? error.code : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        },
      );
    },
  );
}

async function withSocketServer(
  handler: (socket: net.Socket, request: Record<string, unknown>) => void,
  run: (socketPath: string) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-client-owner-"));
  const socketPath = path.join(dir, "daemon.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handler(socket, JSON.parse(buffer.slice(0, newline)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("daemon command scripts return only matching successful responses", async () => {
  await withSocketServer(
    (socket, request) => {
      socket.write("not-json\n");
      socket.end(
        `${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
          data: { source: "command-script" },
        })}\n`,
      );
    },
    async (socketPath) => {
      const result = await runScript(
        client.buildDaemonCommandScript(
          { type: "usage", value: 1 },
          socketPath,
          200,
          "usage-owner",
        ),
      );
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "null");
    },
  );

  await withSocketServer(
    (socket, request) => {
      socket.write(
        `${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
          data: { source: "command-script" },
        })}\n`,
      );
    },
    async (socketPath) => {
      const result = await runScript(
        client.buildDaemonCommandScript(
          { type: "usage", value: 1 },
          socketPath,
          200,
          "usage-owner",
        ),
      );
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        source: "command-script",
      });
    },
  );
});

test("daemon generated scripts resolve default socket and timeout values", () => {
  const probe = client.buildDaemonSocketProbeScript();
  const status = client.buildDaemonStatusScript(undefined, undefined, "");
  assert.match(probe, /rin-daemon/);
  assert.match(probe, /const timeoutMs = 500/);
  assert.match(status, /const timeoutMs = 1500/);
});

test("daemon generated scripts handle unavailable and failed sockets", async () => {
  const missingPath = path.join(
    os.tmpdir(),
    `rin-missing-daemon-${process.pid}-${Date.now()}.sock`,
  );
  const probe = await runScript(
    client.buildDaemonSocketProbeScript(missingPath, 20),
  );
  assert.equal(probe.code, 1);

  const command = await runScript(
    client.buildDaemonCommandScript({ type: "status" }, missingPath, 20, ""),
  );
  assert.equal(command.code, 0);
  assert.equal(command.stdout, "null");

  const status = await runScript(
    client.buildDaemonStatusScript(missingPath, 20, ""),
  );
  assert.equal(status.code, 0);
  assert.equal(status.stdout, "null");
});

test("daemon request client handles payload fallback, default ids, and timeout", async () => {
  await withSocketServer(
    (socket, request) => {
      socket.end(
        `${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
        })}\n`,
      );
    },
    async (socketPath) => {
      const result = await client.requestDaemonCommand(
        { type: "status" },
        { socketPath, timeoutMs: 200 },
      );
      assert.equal(result.type, "response");
      assert.equal(result.command, "status");
      assert.match(result.id, /^daemon_/);
    },
  );

  await withSocketServer(
    () => undefined,
    async (socketPath) => {
      await assert.rejects(
        client.requestDaemonCommand({}, { socketPath, timeoutMs: 20 }),
        /daemon_timeout:unknown/,
      );
    },
  );

  await assert.rejects(
    client.requestDaemonCommand(
      { type: "status" },
      { socketPath: "/missing/rin-owner.sock", timeoutMs: 20 },
    ),
  );
});
