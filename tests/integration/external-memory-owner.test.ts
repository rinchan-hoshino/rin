import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const externalMemory = await importBuiltModule<
  typeof import("../../src/core/memory/external.js")
>("dist/core/memory/external.js");

async function listen(server: net.Server, socketPath: string) {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: net.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("external memory uses the daemon boundary for searches and writes", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-external-memory-owner-"),
  );
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const requests: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      const data =
        request.type === "memory_search_external"
          ? {
              results: [
                {
                  provider: "archive",
                  id: "entry-1",
                  name: "First entry",
                  messages: [{ role: "user", line: 2, text: "remembered" }],
                },
              ],
            }
          : { stored: true };
      socket.end(
        `${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: true,
          data,
        })}\n`,
      );
    });
  });

  try {
    assert.deepEqual(
      await externalMemory.searchExternalMemoryProviders("before server"),
      [],
    );
    await externalMemory.writeExternalMemoryEntry({ id: "offline" } as never);

    await listen(server, socketPath);
    const results = await externalMemory.searchExternalMemoryProviders(
      "  owner query  ",
      { limit: 2, provider: "archive" },
    );
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      provider: "archive",
      id: "entry-1",
      name: "First entry",
      messages: [
        {
          role: "user",
          timestamp: "",
          line: 2,
          text: "remembered",
        },
      ],
      sourceType: "external",
      score: 2,
    });
    assert.deepEqual(requests[0]?.payload, {
      limit: 2,
      provider: "archive",
      query: "owner query",
    });

    const entry = { id: "write-1", text: "persist" } as never;
    await externalMemory.writeExternalMemoryEntry(entry);
    assert.equal(requests[1]?.type, "memory_write_external");
    assert.deepEqual(requests[1]?.payload, entry);
  } finally {
    if (server.listening) await close(server);
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("external memory converts daemon request failures to empty outcomes", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-external-memory-failure-"),
  );
  const socketPath = path.join(runtimeDir, "rin-daemon", "daemon.sock");
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim());
      socket.end(
        `${JSON.stringify({
          type: "response",
          id: request.id,
          command: request.type,
          success: false,
          error: "external provider unavailable",
        })}\n`,
      );
    });
  });
  try {
    await listen(server, socketPath);
    assert.deepEqual(
      await externalMemory.searchExternalMemoryProviders("request failure"),
      [],
    );
    await externalMemory.writeExternalMemoryEntry({ id: "ignored" } as never);
  } finally {
    await close(server);
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
