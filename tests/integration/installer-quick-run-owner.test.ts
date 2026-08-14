import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

await import("../support/register-quick-run-owner-fixture.ts");
const rootDir = path.resolve(".");
const quickRun = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "quick-run.js"),
  ).href
);

const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinQuickRunEvents as any[];
const children = ownerGlobal.__rinQuickRunChildren as any[];
const scenario = ownerGlobal.__rinQuickRunScenario as Record<string, any>;

async function withQuickRunSandbox(
  run: (fixture: {
    root: string;
    home: string;
    installDir: string;
  }) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-quick-run-owner-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  const installDir = path.join(home, ".rin");
  await fs.mkdir(sourceRoot, { recursive: true });
  events.length = 0;
  children.length = 0;
  ownerGlobal.__rinQuickRunConnectCalls = 0;
  Object.assign(scenario, {
    home,
    sourceRoot,
    socketPath: path.join(root, "daemon.sock"),
    currentUser: "owner",
    alreadyRunning: false,
    daemonExit: 0,
    neverReady: false,
    holdTui: false,
    tuiCode: 0,
    tuiSignal: null,
    shutdownTrigger: "",
    shutdownScheduled: false,
    models: [],
    promptSetup: {
      provider: "prompted",
      modelId: "prompted-model",
      thinkingLevel: "off",
      authResult: { authData: { prompted: true } },
    },
  });
  process.exitCode = undefined;
  try {
    await run({ root, home, installDir });
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode != null || child.signalCode) return resolve();
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          }),
      ),
    );
    process.exitCode = undefined;
    await fs.rm(root, { recursive: true, force: true });
  }
}

function model(
  provider: string,
  id: string,
  available: boolean,
  reasoning = true,
) {
  return {
    provider,
    providerLabel: provider,
    authKind: "subscription",
    id,
    reasoning,
    available,
  };
}

test("quick run selects existing providers through observable model and auth precedence", () => {
  const stored = quickRun.pickQuickRunExistingProvider({
    models: [model("owner", "configured", false)],
    settings: {
      defaultProvider: "owner",
      defaultModel: "configured",
      defaultThinkingLevel: "invalid",
    },
    authData: { owner: { type: "oauth" } },
  });
  assert.equal(stored?.modelId, "configured");
  assert.equal(stored?.thinkingLevel, "off");

  const providerDefault = quickRun.pickQuickRunExistingProvider({
    models: [
      model("owner", "configured", false),
      model("owner", "available", true),
    ],
    settings: { defaultProvider: "owner", defaultModel: "missing" },
    authData: {},
  });
  assert.equal(providerDefault?.modelId, "available");

  const availableDefault = quickRun.pickQuickRunExistingProvider({
    models: [model("other", "fallback", true, false)],
    settings: null,
    authData: null,
  });
  assert.equal(availableDefault?.provider, "other");
  assert.equal(availableDefault?.thinkingLevel, "off");
  assert.equal(
    quickRun.pickQuickRunExistingProvider({
      models: [model("none", "offline", false)],
      settings: {},
      authData: {},
    }),
    null,
  );
});

test("quick run prepares only sandbox state and launches temporary daemon then TUI", async () => {
  await withQuickRunSandbox(async ({ home, installDir }) => {
    scenario.models = [model("openai", "codex", true)];
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "settings.json"),
      JSON.stringify({
        language: "zh_CN",
        defaultProvider: "openai",
        defaultModel: "codex",
        defaultThinkingLevel: "medium",
      }),
    );
    await fs.writeFile(
      path.join(installDir, "auth.json"),
      JSON.stringify({ openai: { type: "oauth" } }),
    );
    scenario.tuiCode = 7;

    const exitCode = await quickRun.runQuickRun();

    assert.equal(quickRun.quickRunInstallDirForCurrentUser(home), installDir);
    const finalized = JSON.parse(
      await fs.readFile(
        path.join(installDir, "quick-run-finalized.json"),
        "utf8",
      ),
    );
    assert.deepEqual(finalized, {
      currentUser: "owner",
      targetUser: "owner",
      installDir,
      provider: "openai",
      modelId: "codex",
      thinkingLevel: "medium",
      authData: { openai: { type: "oauth" } },
      sourceRoot: scenario.sourceRoot,
    });
    const spawns = events.filter(([kind]) => kind === "spawn");
    assert.deepEqual(
      spawns.map((entry) => [entry[1], entry[3][0], entry[4].cwd]),
      [
        [
          "daemon",
          path.join(scenario.sourceRoot, "dist/app/rin-daemon/daemon.js"),
          scenario.sourceRoot,
        ],
        [
          "tui",
          path.join(scenario.sourceRoot, "dist/app/rin-tui/main.js"),
          scenario.sourceRoot,
        ],
      ],
    );
    assert.equal(spawns[0][4].env.RIN_DIR, installDir);
    assert.equal(spawns[0][4].env.PI_CODING_AGENT_DIR, installDir);
    assert.equal(spawns[0][4].env.RIN_QUICK_RUN, "1");
    assert.equal(spawns[0][4].env.RIN_SKIP_VERSION_CHECK, "1");
    assert.equal(exitCode, 7);
  });
});

test("quick run prompts only when no usable existing provider remains", async () => {
  await withQuickRunSandbox(async ({ installDir }) => {
    scenario.models = [model("offline", "model", false)];
    await quickRun.runQuickRun();
    const finalized = JSON.parse(
      await fs.readFile(
        path.join(installDir, "quick-run-finalized.json"),
        "utf8",
      ),
    );
    assert.equal(finalized.provider, "prompted");
    assert.equal(finalized.modelId, "prompted-model");
    assert.equal(Object.hasOwn(finalized, "language"), false);
    assert.equal(
      events.some(([kind]) => kind === "prompt-provider"),
      true,
    );
  });
});

test("quick run rejects an occupied socket and a daemon that exits before readiness", async () => {
  await withQuickRunSandbox(async () => {
    scenario.alreadyRunning = true;
    await assert.rejects(
      quickRun.runQuickRun(),
      /rin_quick_run_daemon_already_running/,
    );
    assert.equal(
      events.some(([kind]) => kind === "spawn"),
      false,
    );
  });

  await withQuickRunSandbox(async () => {
    scenario.daemonExit = 23;
    await assert.rejects(
      quickRun.runQuickRun(),
      /rin_quick_run_daemon_exited:23/,
    );
    assert.deepEqual(
      events.filter(([kind]) => kind === "spawn").map((entry) => entry[1]),
      ["daemon"],
    );
  });
});

test("quick run forwards TUI and shutdown signals and removes temporary listeners", async () => {
  await withQuickRunSandbox(async () => {
    scenario.tuiSignal = "SIGTERM";
    assert.equal(await quickRun.runQuickRun(), 143);
  });

  await withQuickRunSandbox(async () => {
    const beforeSignals = Object.fromEntries(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((name) => [
        name,
        process.listenerCount(name),
      ]),
    );
    const beforeEnd = process.stdin.listenerCount("end");
    const beforeClose = process.stdin.listenerCount("close");
    scenario.holdTui = true;
    scenario.shutdownTrigger = "SIGHUP";

    const exitCode = await quickRun.runQuickRun();

    assert.equal(exitCode, 129);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      assert.equal(process.listenerCount(name), beforeSignals[name]);
    }
    assert.equal(process.stdin.listenerCount("end"), beforeEnd);
    assert.equal(process.stdin.listenerCount("close"), beforeClose);
    assert.equal(
      children.every((child) => child.exitCode != null || child.signalCode),
      true,
    );
  });

  await withQuickRunSandbox(async () => {
    scenario.holdTui = true;
    scenario.shutdownTrigger = "stdin";
    assert.equal(await quickRun.runQuickRun(), 129);
  });
});

test("quick run runtime environment preserves caller values while owning Rin selectors", () => {
  assert.deepEqual(
    quickRun.createQuickRunRuntimeEnv("/sandbox/.rin", { OWNER: "kept" }),
    {
      OWNER: "kept",
      RIN_DIR: "/sandbox/.rin",
      PI_CODING_AGENT_DIR: "/sandbox/.rin",
      RIN_QUICK_RUN: "1",
      RIN_SKIP_VERSION_CHECK: "1",
    },
  );
});
