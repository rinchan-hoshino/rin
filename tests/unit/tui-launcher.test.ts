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
const cliOptions = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "cli-options.js"))
    .href
);
const sdk = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

test("tui launcher exports frontend SDK wrappers for both rpc and std TUI paths", () => {
  assert.equal(typeof sdk.createFrontendSdkRuntimeWrapper, "function");
  assert.equal(typeof sdk.createFrontendSdkSessionWrapper, "function");
});

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

test("tui launcher formats its own maintenance mode warning", () => {
  assert.match(
    launcher.formatTuiMaintenanceModeNotice(),
    /Rin daemon is unavailable/,
  );
  assert.match(
    launcher.formatTuiMaintenanceModeNotice(),
    /Entering temporary maintenance mode/,
  );
});

test("tui launcher parses pi extension resource options without leaking paths into prompts", () => {
  const parsed = cliOptions.parseTuiCliOptions(
    [
      "-e",
      "./ext.ts",
      "--no-extensions",
      "--skill",
      "./skill",
      "--prompt-template=./prompt.md",
      "--theme",
      "theme.json",
      "--plan",
      "strict",
      "hello",
    ],
    "/repo",
  );

  assert.equal(parsed.initialMessage, "hello");
  assert.deepEqual(parsed.resources.additionalExtensionPaths, [
    path.join("/repo", "ext.ts"),
  ]);
  assert.equal(parsed.resources.noExtensions, true);
  assert.deepEqual(parsed.resources.additionalSkillPaths, [
    path.join("/repo", "skill"),
  ]);
  assert.deepEqual(parsed.resources.additionalPromptTemplatePaths, [
    path.join("/repo", "prompt.md"),
  ]);
  assert.deepEqual(parsed.resources.additionalThemePaths, [
    path.join("/repo", "theme.json"),
  ]);
  assert.equal(parsed.resources.extensionFlagValues?.get("plan"), "strict");
});

test("rpc tui reuses a pre-initialized interactive mode without starting it twice", async () => {
  let initCount = 0;
  let runCalled = false;
  const interactiveMode = {
    async init() {
      initCount += 1;
    },
    async run() {
      await this.init();
      runCalled = true;
    },
  };

  await interactiveMode.init();
  await launcher.runPreinitializedInteractiveMode(interactiveMode);

  assert.equal(initCount, 1);
  assert.equal(runCalled, true);
});

test("rpc startup prepares the daemon worker before interactive mode init", async () => {
  const calls: string[] = [];
  await launcher.prepareRpcSessionWorkerForInteractiveStartup(
    {
      settingsManager: { getQuietStartup: () => true },
      async prepareForInteractiveStartup() {
        calls.push("prepare");
      },
      async connect() {
        calls.push("connect");
      },
      async ensureSessionReady() {
        calls.push("ensureSessionReady");
      },
    },
    { verbose: true },
    {
      mark(label: string) {
        calls.push(`mark:${label}`);
      },
    },
  );

  assert.deepEqual(calls, [
    "prepare",
    "connect",
    "ensureSessionReady",
    "mark:rpc-session-created",
  ]);
});

test("tui launcher clears the visible viewport before taking over the terminal", () => {
  const writes: string[] = [];
  launcher.clearVisibleTerminalForTuiStartup({
    isTTY: true,
    write(value: string) {
      writes.push(value);
      return true;
    },
  });
  launcher.clearVisibleTerminalForTuiStartup({
    isTTY: false,
    write(value: string) {
      writes.push(value);
      return true;
    },
  });

  assert.deepEqual(writes, ["\x1b[2J\x1b[H"]);
});

test("tui launcher maps init mode to hidden onboarding guidance", () => {
  const parsed = cliOptions.parseTuiCliOptions(["--init"]);

  assert.equal(parsed.initialMessage, "Start Rin initialization.");
  assert.equal(parsed.initialMessages, undefined);
  assert.equal(parsed.resources.appendSystemPrompt?.length, 1);
  assert.ok(
    parsed.resources.appendSystemPrompt?.[0].includes(
      "~/.rin/docs/rin/docs/initialization.md",
    ),
  );
});

test("tui launcher maps quiet startup to Pi version-check skip env", () => {
  const env = {};
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    {},
    env,
  );
  assert.equal(env.RIN_SKIP_VERSION_CHECK, "1");

  const verboseEnv = {};
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    { verbose: true },
    verboseEnv,
  );
  assert.equal(verboseEnv.RIN_SKIP_VERSION_CHECK, undefined);

  const existingEnv = { RIN_SKIP_VERSION_CHECK: "custom" };
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    {},
    existingEnv,
  );
  assert.equal(existingEnv.RIN_SKIP_VERSION_CHECK, "custom");
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

test("tui launcher maps internal startup error markers to actionable messages", () => {
  assert.equal(
    launcher.formatTuiStartupError(new Error("rin_request_failed")),
    "Rin request failed. Retry the command; if it repeats, run rin doctor.",
  );
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
        requestedRole: "rpc-frontend",
        socketPath,
        timeoutMs: 500,
      }),
      false,
    );
    assert.equal(
      await launcher.shouldStartMaintenanceMode({
        requestedRole: "maintenance-tui",
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
