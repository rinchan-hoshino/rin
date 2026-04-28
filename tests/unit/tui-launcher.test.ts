import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const launcher = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "launcher.js"))
    .href
);

test("tui launcher resolves interactive startup options", () => {
  assert.deepEqual(launcher.resolveTuiInteractiveOptions([]), {
    initialMessage: undefined,
    initialMessages: undefined,
    verbose: undefined,
  });
  assert.deepEqual(launcher.resolveTuiInteractiveOptions(["--verbose"]), {
    initialMessage: undefined,
    initialMessages: undefined,
    verbose: true,
  });
  assert.deepEqual(launcher.resolveTuiInteractiveOptions(["/init", "next"]), {
    initialMessage: "/init",
    initialMessages: ["next"],
    verbose: undefined,
  });
  assert.deepEqual(
    launcher.resolveTuiInteractiveOptions(["--unknown", "--", "--literal"]),
    {
      initialMessage: "--literal",
      initialMessages: undefined,
      verbose: undefined,
    },
  );
});

test("tui launcher prints its startup separator independently of startup verbosity", () => {
  const quietSession = {
    settingsManager: {
      getQuietStartup: () => true,
    },
  };

  assert.equal(launcher.shouldPrintStartupSeparator(quietSession), true);
  assert.equal(
    launcher.shouldPrintStartupSeparator(undefined, { verbose: false }),
    true,
  );
});

test("tui launcher formats daemon startup socket failures with doctor/reopen guidance", () => {
  const message = launcher.formatTuiStartupError(
    new Error("connect ECONNREFUSED /run/user/1001/rin-daemon/daemon.sock"),
  );
  assert.match(
    message,
    /RPC TUI could not connect to the daemon \(connect ECONNREFUSED \/run\/user\/1001\/rin-daemon\/daemon\.sock\)\./,
  );
  assert.match(message, /Try `rin doctor`/);
  assert.match(message, /temporary maintenance mode/);
});

test("tui launcher classifies transient rpc startup failures as maintenance fallbacks", () => {
  assert.equal(
    launcher.isRecoverableRpcStartupError(
      new Error("connect ECONNREFUSED /run/user/1001/rin-daemon/daemon.sock"),
    ),
    true,
  );
  assert.equal(
    launcher.isRecoverableRpcStartupError(new Error("rin_timeout:get_state")),
    true,
  );
  assert.equal(launcher.isRecoverableRpcStartupError(new Error("boom")), false);

  const notice = launcher.formatTuiMaintenanceFallbackNotice(
    new Error("rin_timeout:rpc_session_ready"),
  );
  assert.match(notice, /Entering temporary maintenance mode/);
  assert.match(notice, /rin doctor/);
});

test("tui launcher startup timeout rejects with a bounded startup error", async () => {
  await assert.rejects(
    launcher.withTuiStartupTimeout(new Promise(() => {}), 10, "demo"),
    /rin_timeout:demo/,
  );
});

test("tui launcher leaves unrelated startup errors unchanged", () => {
  assert.equal(launcher.formatTuiStartupError(new Error("boom")), "boom");
});

test("tui launcher treats daemon status as the rpc startup health check", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-tui-launcher-"),
  );
  const socketPath = path.join(runtimeDir, "daemon.sock");
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
            id: payload.id,
            command: payload.type,
            success: true,
            data: { ok: true },
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
    assert.equal(
      await launcher.isDaemonReadyForRpcStartup({ socketPath, timeoutMs: 500 }),
      true,
    );
    assert.equal(requests[0].type, "daemon_status");
    assert.equal(
      await launcher.shouldStartMaintenanceMode({
        env: { RIN_TUI_RUNTIME_ROLE: "rpc-frontend" },
        socketPath,
        timeoutMs: 500,
      }),
      false,
    );
    assert.equal(
      await launcher.shouldStartMaintenanceMode({
        env: { RIN_TUI_RUNTIME_ROLE: "maintenance-tui" },
        socketPath: path.join(runtimeDir, "missing.sock"),
        timeoutMs: 1,
      }),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }

  assert.equal(
    await launcher.isDaemonReadyForRpcStartup({ socketPath, timeoutMs: 50 }),
    false,
  );
});
