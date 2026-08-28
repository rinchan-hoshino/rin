import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-tui-launcher-owner-fixture.ts");
const launcher = await import(
  pathToFileURL(path.resolve("dist/core/rin-tui/launcher.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinTuiOwnerEvents as any[];
const scenario = ownerGlobal.__rinTuiOwnerScenario as Record<string, any>;

function reset() {
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  scenario.runtime = { cwd: process.cwd(), agentDir: "/owner/agent" };
  scenario.daemonResults = [{ ready: true }];
  scenario.parsed = {
    initialMessage: "owner prompt",
    initialMessages: ["owner followup"],
    verbose: false,
    sessionName: "owner session",
    resources: {
      additionalExtensionPaths: ["/parsed/extension"],
      appendSystemPrompt: ["existing"],
    },
  };
  scenario.quiet = true;
  scenario.onboarding = false;
}

function names() {
  return events.map(([name]) => name);
}

test("launcher owns terminal animation, clearing, timeout, and maintenance notices", async () => {
  reset();
  const writes: string[] = [];
  const status = launcher.startTuiStartupStatusAnimation(
    {
      isTTY: true,
      write(value: string) {
        writes.push(value);
      },
    },
    { intervalMs: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 4));
  status.stop();
  status.stop();
  assert.equal(
    writes.filter((value) => value.includes("Starting...")).length >= 2,
    true,
  );
  assert.equal(writes.at(-1), "\r\x1b[K");

  const inertWrites: string[] = [];
  launcher.startTuiStartupStatusAnimation({ isTTY: false }).stop();
  launcher.clearVisibleTerminalForTuiStartup({ isTTY: false });
  launcher.clearVisibleTerminalForTuiStartup({
    isTTY: true,
    write(value: string) {
      inertWrites.push(value);
    },
  });
  assert.deepEqual(inertWrites, ["\x1b[2J\x1b[H"]);

  assert.equal(
    await launcher.withTuiStartupTimeout(Promise.resolve("owner"), 10, "ready"),
    "owner",
  );
  await assert.rejects(
    launcher.withTuiStartupTimeout(new Promise(() => {}), 0, "owner-step"),
    /rin_timeout:owner-step/,
  );

  scenario.formattedError = "";
  assert.equal(
    launcher.formatTuiMaintenanceFallbackNotice(undefined),
    "RPC TUI startup is unavailable. Entering temporary maintenance mode; run `rin doctor` if this keeps happening.",
  );
  scenario.formattedError = "owner detail";
  assert.match(
    launcher.formatTuiMaintenanceFallbackNotice(new Error("raw")),
    /\(owner detail\)/,
  );
  assert.match(
    launcher.formatTuiMaintenanceModeNotice(),
    /Some features may be unavailable/,
  );
  const requestedNotice = launcher.formatTuiMaintenanceModeNotice(true);
  assert.match(requestedNotice, /requested with --maint/);
  assert.doesNotMatch(requestedNotice, /daemon is unavailable/);
});

test("launcher owns daemon readiness, option resolution, quiet startup, and onboarding mutation", async () => {
  reset();
  scenario.daemonResults = [new Error("connect ENOENT"), { ok: true }];
  assert.equal(
    await launcher.isDaemonReadyForRpcStartup({ timeoutMs: 20, pollMs: 1 }),
    true,
  );
  assert.equal(
    await launcher.shouldStartMaintenanceMode({
      requestedRole: "maintenance-tui",
    }),
    true,
  );

  scenario.daemonResults = Array.from(
    { length: 20 },
    () => new Error("offline"),
  );
  assert.equal(
    await launcher.isDaemonReadyForRpcStartup({ timeoutMs: 3, pollMs: 1 }),
    false,
  );
  scenario.daemonResults = [{ ok: true }];
  assert.equal(
    await launcher.shouldStartMaintenanceMode({
      requestedRole: "rpc-frontend",
      timeoutMs: 10,
    }),
    false,
  );

  assert.deepEqual(launcher.resolveTuiInteractiveOptions(["--owner"]), {
    initialMessage: "owner prompt",
    initialMessages: ["owner followup"],
    verbose: false,
    sessionName: "owner session",
  });

  const env: NodeJS.ProcessEnv = {};
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    { verbose: false },
    env,
  );
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    { verbose: false },
    env,
  );
  assert.equal(env.RIN_SKIP_VERSION_CHECK, "1");
  const verboseEnv: NodeJS.ProcessEnv = {};
  launcher.applyQuietStartupVersionCheckEnv(
    { getQuietStartup: () => true },
    { verbose: true },
    verboseEnv,
  );
  launcher.applyQuietStartupVersionCheckEnv(undefined, {}, verboseEnv);
  assert.equal(verboseEnv.RIN_SKIP_VERSION_CHECK, undefined);

  const resources: any = { appendSystemPrompt: ["existing"] };
  const interactive: any = {
    initialMessage: "remove",
    initialMessages: ["remove"],
  };
  scenario.onboarding = false;
  assert.deepEqual(
    await launcher.applyTuiOnboardingStartupState(
      "/owner/agent",
      resources,
      interactive,
    ),
    { shouldStart: false },
  );
  assert.equal(interactive.initialMessage, "remove");

  scenario.onboarding = true;
  await launcher.applyTuiOnboardingStartupState(
    "/owner/agent",
    resources,
    interactive,
  );
  assert.deepEqual(resources.appendSystemPrompt, [
    "existing",
    "owner onboarding",
  ]);
  assert.equal(interactive.initialMessage, undefined);
  assert.equal(interactive.initialMessages, undefined);
  assert.equal(interactive.rinStartHiddenInitialization, true);
});

test("launcher prepares RPC then delegates the InteractiveMode lifecycle to Pi", async () => {
  reset();
  const calls: string[] = [];
  const rpc = {
    settingsManager: { getQuietStartup: () => true },
    async prepareForInteractiveStartup() {
      calls.push("prepare");
    },
    async connect() {
      calls.push("connect");
    },
    async ensureSessionReady() {
      calls.push("ready");
    },
    async setSessionName(name: string) {
      calls.push(`name:${name}`);
    },
  };
  const profile = { mark: (label: string) => calls.push(`mark:${label}`) };
  await launcher.prepareRpcSessionWorkerForInteractiveStartup(
    rpc,
    { sessionName: "owner", verbose: false },
    profile,
  );
  await launcher.prepareRpcSessionWorkerForInteractiveStartup(rpc, {}, profile);
  assert.deepEqual(calls, [
    "prepare",
    "connect",
    "ready",
    "name:owner",
    "mark:rpc-session-created",
    "prepare",
    "connect",
    "ready",
    "mark:rpc-session-created",
  ]);

  const stopped: string[] = [];
  await launcher.stopInteractiveModeAfterTerminalQueries(
    { stop: () => stopped.push("stop") },
    async (delay: number) => stopped.push(`wait:${delay}`),
  );
  assert.deepEqual(stopped, ["wait:150", "stop"]);

  const initialized: string[] = [];
  const mode: any = {
    async init() {
      initialized.push("init");
    },
    async run() {
      initialized.push("run");
      await this.init();
    },
    stop() {
      initialized.push("stop");
    },
  };
  await launcher.runInteractiveModeInstance(mode);
  assert.deepEqual(initialized, ["run", "init"]);

  initialized.length = 0;
  mode.run = async function () {
    initialized.push("run");
    await this.init();
    throw new Error("owner run failed");
  };
  await assert.rejects(
    launcher.runInteractiveModeInstance(mode),
    /owner run failed/,
  );
  assert.deepEqual(initialized, ["run", "init", "stop"]);
});

test("startTui owns rpc success, startup cleanup, maintenance fallback, and fatal propagation", async () => {
  reset();
  await launcher.startTui({
    argv: ["--owner"],
    additionalExtensionPaths: ["/legacy/extension"],
    resourceOptions: {
      additionalExtensionPaths: ["/explicit/extension"],
      noExtensions: true,
    },
  });
  assert.equal(names().includes("rpc-session"), true);
  assert.equal(names().includes("runtime-dispose"), true);
  assert.equal(names().includes("configured-session"), false);
  assert.deepEqual(
    events.find(([name]) => name === "rpc-session")?.[1]
      .additionalExtensionPaths,
    ["/explicit/extension"],
  );
  assert.equal(
    events.some(([name, role]) => name === "role" && role === "rpc-frontend"),
    true,
  );

  reset();
  scenario.rpcConnectError = new Error("connect ECONNRESET /owner.sock");
  await launcher.startTui();
  assert.equal(names().includes("rpc-disconnect"), true);
  assert.equal(names().includes("configured-session"), true);
  assert.equal(
    events.some(
      ([name, role]) => name === "role" && role === "maintenance-tui",
    ),
    true,
  );
  assert.match(
    events.find(([name]) => name === "interactive-construct")?.[2]
      .rinStartupWarnings[0],
    /Entering temporary maintenance mode/,
  );

  reset();
  scenario.rpcReadyError = new Error("rin_worker_exit");
  await launcher.startTui();
  assert.equal(names().includes("rpc-disconnect"), true);
  assert.equal(names().includes("configured-session"), true);
  assert.equal(
    events.some(
      ([name, role]) => name === "role" && role === "maintenance-tui",
    ),
    true,
  );

  reset();
  scenario.interactiveInitError = new Error("owner init fatal");
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: any, delay?: number, ...args: any[]) => {
    if (delay === 150) {
      events.push(["terminal-query-wait", delay]);
      return originalSetTimeout(handler, 0, ...args);
    }
    return originalSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
  try {
    await assert.rejects(launcher.startTui(), /owner init fatal/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(names().includes("interactive-stop"), true);
  assert.equal(names().includes("runtime-dispose"), true);
  assert.equal(names().includes("terminal-query-wait"), true);
  assert.equal(
    names().indexOf("terminal-query-wait") <
      names().indexOf("interactive-stop"),
    true,
  );

  reset();
  scenario.interactiveRunError = new Error("owner run fatal");
  await assert.rejects(launcher.startTui(), /owner run fatal/);
  assert.equal(names().includes("interactive-stop"), true);
  assert.equal(names().includes("runtime-dispose"), true);

  reset();
  scenario.rpcPrepareError = "owner scalar fatal";
  await assert.rejects(launcher.startTui(), /owner scalar fatal/);
  assert.equal(names().includes("rpc-disconnect"), true);
});

test("startTui sends every daemon-dependent startup failure to maintenance", async (t) => {
  const failures = [
    ["rpcConnectError", "owner future connect failure"],
    ["rpcReadyError", "rin_daemon_recovering"],
    ["rpcReadyError", "rin_daemon_shutting_down"],
    ["rpcReadyError", "rin_no_attached_session"],
    ["rpcReadyError", "rin_session_worker_unavailable"],
    ["rpcReadyError", "rin_worker_exit"],
    ["rpcReadyError", "rin_worker_oom"],
    ["rpcReadyError", "rin_worker_cleanup_failed"],
    ["rpcReadyError", "rin_worker_state_unavailable"],
    ["rpcReadyError", "rin_worker_stdin_unavailable:get_state"],
    ["rpcReadyError", "Rin worker process id is unavailable"],
    ["rpcReadyError", "owner future session startup failure"],
    ["rpcNameError", "owner future session name failure"],
  ] as const;

  for (const [field, message] of failures) {
    await t.test(`${field}: ${message}`, async () => {
      reset();
      scenario[field] = new Error(message);
      await launcher.startTui();
      assert.equal(names().includes("rpc-disconnect"), true);
      assert.equal(names().includes("configured-session"), true);
      assert.equal(
        events.some(
          ([name, role]) => name === "role" && role === "maintenance-tui",
        ),
        true,
      );
    });
  }
});

test("startTui presents explicitly requested maintenance without claiming daemon failure", async () => {
  reset();
  const previousRole = process.env.RIN_TUI_RUNTIME_ROLE;
  const previousRequest = process.env.RIN_TUI_MAINTENANCE_REQUESTED;
  process.env.RIN_TUI_RUNTIME_ROLE = "maintenance-tui";
  process.env.RIN_TUI_MAINTENANCE_REQUESTED = "1";
  try {
    await launcher.startTui({ resourceOptions: { noTools: true } });
  } finally {
    if (previousRole === undefined) delete process.env.RIN_TUI_RUNTIME_ROLE;
    else process.env.RIN_TUI_RUNTIME_ROLE = previousRole;
    if (previousRequest === undefined)
      delete process.env.RIN_TUI_MAINTENANCE_REQUESTED;
    else process.env.RIN_TUI_MAINTENANCE_REQUESTED = previousRequest;
  }
  assert.equal(names().includes("configured-session"), true);
  assert.equal(names().includes("rpc-session"), false);
  assert.equal(
    events.find(([name]) => name === "interactive-construct")?.[2]
      .rinStartupWarnings[0],
    launcher.formatTuiMaintenanceModeNotice(true),
  );
});

test("startTui enters maintenance directly when daemon readiness expires", async () => {
  reset();
  scenario.daemonResults = Array.from(
    { length: 5 },
    () => new Error("offline"),
  );
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => (now += 31_000);
  try {
    await launcher.startTui({ resourceOptions: { noTools: true } });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(names().includes("configured-session"), true);
  assert.equal(names().includes("rpc-session"), false);
  assert.equal(
    events.find(([name]) => name === "interactive-construct")?.[2]
      .rinStartupWarnings[0],
    launcher.formatTuiMaintenanceModeNotice(),
  );
});
