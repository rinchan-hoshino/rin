import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createTestSandbox } from "../support/test-sandbox.js";

const execFileAsync = promisify(execFile);
const entrypoint = path.resolve("dist/app/rin/main.js");

test("nerve CLI exposes status, emit, abort, and trigger reload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-nerve-cli-"));
  const sandbox = await createTestSandbox(root);
  const socketPath = sandbox.env.RIN_DAEMON_SOCKET_PATH!;
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.chmod(path.dirname(socketPath), 0o700);
  const commands: any[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const command = JSON.parse(line);
        commands.push(command);
        socket.write(
          `${JSON.stringify({
            type: "response",
            command: command.type,
            id: command.id,
            success: true,
            data: { accepted: true },
          })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const env = {
    ...sandbox.env,
    RIN_TARGET_USER: process.env.USER || "node",
  };
  try {
    for (const args of [
      ["nerve", "status"],
      [
        "nerve",
        "emit",
        "--id",
        "event-1",
        "--producer",
        "cli-test",
        "--sensation",
        "test",
        "--body",
        "payload",
      ],
      ["nerve", "abort"],
      ["nerve", "reload", "clock"],
    ]) {
      const result = await execFileAsync(
        process.execPath,
        [entrypoint, ...args],
        {
          env,
        },
      );
      assert.match(result.stdout, /accepted/u);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(
    commands.map((command) => command.type),
    ["nerve_status", "nerve_emit", "nerve_abort", "nerve_reload_trigger"],
  );
  assert.deepEqual(commands[1].payload, {
    id: "event-1",
    producer: "cli-test",
    sensation: "test",
    body: "payload",
  });
  assert.deepEqual(commands[3].payload, { id: "clock" });
});
