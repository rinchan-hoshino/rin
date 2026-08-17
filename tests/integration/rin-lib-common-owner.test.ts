import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const common = await importBuiltModule<
  typeof import("../../src/core/rin-lib/common.js")
>("dist/core/rin-lib/common.js");

function pipeHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function withPlatform(
  platform: NodeJS.Platform,
  run: () => void | Promise<void>,
) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

test("shared socket helpers normalize Windows pipe identities", async () => {
  assert.equal(
    common.windowsNamedPipePath(" Chat Bridge ", "owner@example.com"),
    `\\\\.\\pipe\\rin-chat-bridge-${pipeHash("owner@example.com")}`,
  );
  assert.equal(
    common.windowsNamedPipePath("", ""),
    `\\\\.\\pipe\\rin-default-${pipeHash(os.homedir())}`,
  );
  assert.equal(common.isWindowsNamedPipePath("  \\\\.\\pipe\\rin-demo "), true);
  assert.equal(common.isWindowsNamedPipePath("/tmp/rin.sock"), false);

  await withPlatform("win32", () => {
    assert.equal(
      common.bridgeDaemonSocketPath("C:\\Users\\owner\\.rin"),
      common.windowsNamedPipePath("bridge", "C:\\Users\\owner\\.rin"),
    );
    assert.equal(
      common.defaultDaemonSocketPath(),
      common.windowsNamedPipePath("daemon", os.homedir()),
    );
  });
});

test("shared socket helpers select Unix runtime directories", async () => {
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.XDG_RUNTIME_DIR = "/tmp/rin-runtime-owner";
    await withPlatform("linux", () => {
      assert.equal(
        common.bridgeDaemonSocketPath("/tmp/agent"),
        path.join("/tmp/agent", "data", "core", "daemon", "bridge.sock"),
      );
      assert.equal(
        common.defaultDaemonSocketPath(),
        "/tmp/rin-runtime-owner/rin-daemon/daemon.sock",
      );
    });

    delete process.env.XDG_RUNTIME_DIR;
    await withPlatform("linux", () => {
      assert.equal(
        common.defaultDaemonSocketPath(),
        path.join(
          "/run/user",
          String(process.getuid?.() ?? -1),
          "rin-daemon",
          "daemon.sock",
        ),
      );
    });
    await withPlatform("darwin", () => {
      assert.equal(
        common.defaultDaemonSocketPath(),
        path.join(
          os.homedir(),
          "Library",
          "Caches",
          "rin-daemon",
          "daemon.sock",
        ),
      );
    });
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
  }
});

test("shared JSONL parser preserves partial lines and ignores blanks", () => {
  const state = { buffer: "" };
  const lines: string[] = [];
  common.parseJsonl("first\r\n\nsec", state, (line) => lines.push(line));
  assert.deepEqual(lines, ["first"]);
  assert.equal(state.buffer, "sec");

  common.parseJsonl("ond\n  \nthird\ntrailing", state, (line) =>
    lines.push(line),
  );
  assert.deepEqual(lines, ["first", "second", "third"]);
  assert.equal(state.buffer, "trailing");
});
