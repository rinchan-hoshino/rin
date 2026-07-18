import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

await import("../support/register-finalize-owner-fixture.ts");
const finalize = await import(
  pathToFileURL(path.resolve("dist/core/rin-install/finalize.js")).href
);
const ownerGlobal = globalThis as any;
const events = ownerGlobal.__rinFinalizeEvents as any[];
const scenario = ownerGlobal.__rinFinalizeScenario as Record<string, any>;

async function withSandbox(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-finalize-owner-"));
  events.length = 0;
  for (const key of Object.keys(scenario)) delete scenario[key];
  scenario.currentUser = "owner";
  scenario.sourceRoot = path.join(root, "source");
  scenario.daemonReady = true;
  await fs.mkdir(scenario.sourceRoot, { recursive: true });
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withPlatform(
  platform: NodeJS.Platform,
  run: () => Promise<void>,
) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

function baseOptions(root: string, overrides: Record<string, any> = {}) {
  return {
    currentUser: "owner",
    targetUser: "owner",
    installDir: path.join(root, "install"),
    sourceRoot: scenario.sourceRoot,
    provider: "owner-provider",
    modelId: "owner-model",
    thinkingLevel: "high",
    language: "zh_CN",
    authData: { owner: true },
    release: {
      channel: "stable",
      version: "1.2.3",
      branch: "stable",
      ref: "v1.2.3",
      sourceLabel: "stable 1.2.3",
      archiveUrl: "https://example.invalid/rin.tar.gz",
    },
    ...overrides,
  };
}

function eventNames() {
  return events.map(([name]) => name);
}

test("quick-run finalization persists only sandbox initialization state", async () => {
  await withSandbox(async (root) => {
    const installDir = path.join(root, "quick");
    const result = await finalize.finalizeQuickRunInstall(
      baseOptions(root, { installDir }),
    );

    assert.equal(result.publishedRuntime.releaseRoot, "");
    assert.equal(result.installedService, null);
    assert.equal(result.daemonReady, false);
    assert.equal(result.initializationRequired, true);
    assert.equal(result.written.mode, "persisted");
    assert.equal(result.written.options.setDefaultTarget, false);
    assert.equal(result.written.options.writeLaunchers, false);
    assert.equal(eventNames().includes("publish"), false);
    assert.equal(eventNames().includes("refresh-service"), false);
    assert.equal(eventNames().includes("prepare-tools"), false);
    assert.equal(eventNames().includes("launcher"), false);
  });
});

test("core update publishes runtime, refreshes bound launchers, and restarts after persistence", async () => {
  await withSandbox(async (root) => {
    scenario.previousReleaseName = "previous";
    scenario.elevatedWrite = true;
    scenario.launcherMetadata = {
      defaultTargetUser: "service",
      defaultInstallDir: path.join(root, "install"),
    };
    const options = baseOptions(root, {
      currentUser: "admin",
      targetUser: "service",
    });
    const result = await finalize.finalizeCoreUpdate(options);

    assert.equal(result.mode, "core-only");
    assert.equal(result.written.mode, "normalized");
    assert.equal(
      result.coreUpdateLaunchers.currentLaunchers.rinPath,
      "/homes/admin/.local/bin/rin",
    );
    assert.equal(
      result.installerManifest.options.previousReleaseRoot,
      path.join(options.installDir, "app/releases/previous"),
    );
    assert.equal(result.installerManifest.options.service.kind, "systemd");
    assert.equal(result.daemonReady, true);
    assert.deepEqual(
      events
        .filter(([name]) => name === "launcher")
        .map((entry) => [entry[1], entry[3].elevated]),
      [
        ["service", true],
        ["admin", false],
      ],
    );
    assert.equal(
      eventNames().indexOf("manifest") <
        eventNames().lastIndexOf("service-action"),
      true,
    );
    assert.equal(
      eventNames().lastIndexOf("service-action") <
        eventNames().indexOf("wait-socket"),
      true,
    );
  });
});

test("core update isolates optional service installation failure and unrelated launchers", async () => {
  await withSandbox(async (root) => {
    scenario.installServiceError = true;
    scenario.launcherMetadata = { defaultTargetUser: "other" };
    const result = await finalize.finalizeCoreUpdate(
      baseOptions(root, { currentUser: "admin", targetUser: "service" }),
    );
    assert.equal(result.installedService, null);
    assert.equal(result.coreUpdateLaunchers.currentLaunchers, null);
    assert.equal(result.daemonReady, false);
    assert.deepEqual(
      events.filter(([name]) => name === "launcher").map((entry) => entry[1]),
      ["service"],
    );
  });
});

test("installer finalization orders restart before durable persistence and retains initialization", async () => {
  await withSandbox(async (root) => {
    const installDir = path.join(root, "install");
    await fs.mkdir(path.join(installDir, "self_improve/state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(installDir, "self_improve/state/init-state.json"),
      JSON.stringify({ completedAt: "now" }),
    );
    const result = await finalize.finalizeInstallPlan(
      baseOptions(root, { installDir, daemonReadyTimeoutMs: -4 }),
    );

    assert.equal(result.initializationRequired, false);
    assert.equal(result.written.mode, "persisted");
    assert.equal(result.written.options.initializationComplete, true);
    assert.equal(result.daemonReady, true);
    const names = eventNames();
    assert.equal(
      names.indexOf("service-action") < names.indexOf("persist"),
      true,
    );
    assert.deepEqual(
      events.find(([name]) => name === "wait-socket")?.slice(1, 3),
      ["/runtime/owner.sock", 0],
    );
  });
});

test("installer finalization surfaces service installation and readiness failures", async () => {
  await withSandbox(async (root) => {
    scenario.installServiceError = true;
    await assert.rejects(
      finalize.finalizeInstallPlan(baseOptions(root)),
      /owner service install failed/,
    );
  });

  await withSandbox(async (root) => {
    scenario.daemonReady = false;
    await assert.rejects(
      finalize.finalizeInstallPlan(baseOptions(root)),
      /rin_installer_daemon_not_ready\nowner daemon details/,
    );
    assert.equal(eventNames().includes("failure-details"), true);
  });
});

test("git metadata is derived from the sandbox repository without changing explicit fallbacks", async () => {
  await withSandbox(async (root) => {
    const repo = scenario.sourceRoot;
    execFileSync("git", ["init", "-q", "-b", "owner", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "user.email",
      "owner@example.invalid",
    ]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Owner"]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://example.test/owner/rin.git",
    ]);
    await fs.writeFile(path.join(repo, "README.md"), "owner\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "owner"]);
    const hash = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    await finalize.finalizeQuickRunInstall(
      baseOptions(root, {
        release: { channel: "git", branch: "owner" },
      }),
    );
    const persisted = events.find(([name]) => name === "persist")?.[1];
    assert.equal(persisted.release.ref, hash);
    assert.equal(persisted.release.version, hash.slice(0, 12));
    assert.match(
      persisted.release.archiveUrl,
      /example\.test\/owner\/rin\/archive/,
    );

    events.length = 0;
    const explicit = baseOptions(root).release;
    await finalize.finalizeQuickRunInstall(
      baseOptions(root, {
        sourceRoot: path.join(root, "not-a-repo"),
        release: explicit,
      }),
    );
    assert.equal(
      events.find(([name]) => name === "persist")?.[1].release,
      explicit,
    );
  });
});

test("default options and platform service hints preserve all production fallbacks", async () => {
  await withSandbox(async (root) => {
    assert.equal(finalize.defaultDaemonReadyTimeoutMs(), 30_000);
    assert.equal(
      finalize.readExistingInitializationComplete(path.join(root, "missing")),
      false,
    );
    const initialized = path.join(root, "initialized");
    await fs.mkdir(path.join(initialized, "self_improve/state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(initialized, "self_improve/state/init-state.json"),
      JSON.stringify({ initialized: true }),
    );
    assert.equal(
      finalize.readExistingInitializationComplete(initialized),
      true,
    );

    for (const platform of [
      "darwin",
      "linux",
      "win32",
      "freebsd",
    ] as NodeJS.Platform[]) {
      await withPlatform(platform, async () => {
        events.length = 0;
        scenario.installedService = null;
        const result = await finalize.finalizeInstallPlan({
          currentUser: "",
          targetUser: "",
          installDir: "",
          sourceRoot: scenario.sourceRoot,
          provider: "",
          modelId: "",
          thinkingLevel: "",
          language: "",
          authData: undefined,
          publishRuntime: false,
          manageDaemon: false,
          prepareManagedTools: false,
          writeLaunchers: false,
        } as any);
        assert.equal(result.currentUser, "owner");
        assert.equal(result.targetUser, "owner");
        assert.equal(result.installDir, "/homes/owner/.rin");
        assert.equal(result.serviceHint.length > 0, true);
      });
    }
  });
});
