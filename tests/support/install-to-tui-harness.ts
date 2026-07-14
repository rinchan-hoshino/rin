import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);

const fsUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-install", "fs-utils.js"),
  ).href
);
const persist = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "persist.js"))
    .href
);
export const INNER_CONTAINER_ENV = "RIN_INSTALL_TUI_CONTAINER_INNER";
export const DEFAULT_CONTAINER_IMAGE = "node:22-bookworm-slim";

export function isInnerContainerRun() {
  return process.env[INNER_CONTAINER_ENV] === "1";
}

async function removeDirRobust(dir: string, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (i + 1)));
    }
  }
}

export async function withIsolatedTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-install-tui-e2e-"));
  try {
    await fn(dir);
  } finally {
    await removeDirRobust(dir);
  }
}

export async function commandExists(name: string) {
  try {
    await execFileAsync("sh", ["-lc", `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function findContainerRuntime() {
  for (const name of ["docker", "podman"]) {
    if (await commandExists(name)) return name;
  }
  return "";
}

function shellQuote(value: string) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

type PtyCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function startPtyCommand(command: string, env: Record<string, string>) {
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exitPromise = new Promise<PtyCommandResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exitPromise, getOutput: () => output };
}

async function waitForPtyExit(
  exitPromise: Promise<PtyCommandResult>,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPtyProcessGroupAlive(child: ReturnType<typeof spawn>) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPtyProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForPtyProcessGroupExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPtyProcessGroupAlive(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPtyProcessGroupAlive(child);
}

async function stopPtyCommand(
  command: ReturnType<typeof startPtyCommand>,
): Promise<PtyCommandResult> {
  const { child, exitPromise } = command;
  let result: PtyCommandResult | undefined;
  if (child.exitCode !== null || child.signalCode !== null) {
    result = await exitPromise;
  } else {
    if (!child.stdin.destroyed) {
      child.stdin.write("\u0003");
      child.stdin.end();
    }
    result = await waitForPtyExit(exitPromise, 8000);
    if (!result) {
      signalPtyProcessGroup(child, "SIGTERM");
      result = await waitForPtyExit(exitPromise, 2500);
    }
    if (!result) {
      signalPtyProcessGroup(child, "SIGKILL");
      result = await exitPromise;
    }
  }

  if (isPtyProcessGroupAlive(child)) {
    signalPtyProcessGroup(child, "SIGTERM");
    if (!(await waitForPtyProcessGroupExit(child, 2500))) {
      signalPtyProcessGroup(child, "SIGKILL");
      assert.equal(
        await waitForPtyProcessGroupExit(child, 2500),
        true,
        "PTY process group survived SIGKILL",
      );
    }
  }
  return result;
}

function assertExpectedTuiExit(result: PtyCommandResult) {
  assert.ok(
    result.code === 0 ||
      result.code === 1 ||
      result.code === 130 ||
      result.signal === "SIGINT" ||
      result.signal === "SIGTERM",
  );
}

function assertHealthyTuiOutput(output: string) {
  assert.doesNotMatch(output, /rin_not_installed/);
  assert.doesNotMatch(output, /Entering temporary maintenance mode/);
  assert.doesNotMatch(output, /Cannot find module|MODULE_NOT_FOUND/);
  assert.doesNotMatch(
    output,
    /Rin fatal error|TypeError|Cannot read properties/,
  );
}

export type ContainerHarnessMode = "smoke-test" | "manual";

export function buildInstallToTuiContainerArgs(options: {
  mode: ContainerHarnessMode;
  image?: string;
  interactive?: boolean;
  innerArgs?: string[];
}) {
  const image = options.image || DEFAULT_CONTAINER_IMAGE;
  const innerCommand =
    options.mode === "smoke-test"
      ? [
          "node",
          "--import",
          "tsx",
          "--test",
          "--test-reporter",
          "tap",
          "tests/e2e/install-to-tui-user-flow.test.ts",
        ]
      : [
          "node",
          "--import",
          "tsx",
          "tests/interactive/install-to-tui-manual.ts",
          "--inner",
          ...(options.innerArgs || []),
        ];

  return [
    "run",
    "--rm",
    ...(options.interactive ? ["-it"] : []),
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:exec,mode=1777",
    "--tmpfs",
    "/run:exec,mode=755",
    "--mount",
    `type=bind,source=${rootDir},target=${rootDir},readonly`,
    "-w",
    rootDir,
    "-e",
    `${INNER_CONTAINER_ENV}=1`,
    "-e",
    "NO_COLOR=1",
    image,
    ...innerCommand,
  ];
}

export async function runInstallToTuiSmokeInContainer(options: {
  failOnUnavailableRuntime: boolean;
}) {
  const runtime = await findContainerRuntime();
  if (!runtime) {
    if (options.failOnUnavailableRuntime) {
      assert.fail("missing docker or podman for isolated install-to-TUI smoke");
    }
    return {
      skipped: "missing docker or podman for isolated install-to-TUI smoke",
    };
  }

  try {
    const result = await execFileAsync(
      runtime,
      buildInstallToTuiContainerArgs({ mode: "smoke-test" }),
      {
        cwd: rootDir,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const stdout = String(result.stdout || "");
    assert.match(stdout, /# pass 1/);
    return { stdout };
  } catch (error: any) {
    if (options.failOnUnavailableRuntime) throw error;
    const message = String(
      error?.stderr || error?.stdout || error?.message || error,
    )
      .replace(/\s+/g, " ")
      .trim();
    return {
      skipped: `container runtime ${runtime} is not usable for isolated install-to-TUI smoke${message ? `: ${message}` : ""}`,
    };
  }
}

export async function runManualHarnessContainer(options: {
  scripted?: boolean;
  image?: string;
}) {
  const runtime = await findContainerRuntime();
  if (!runtime) {
    throw new Error(
      "missing docker or podman for isolated install-to-TUI manual harness",
    );
  }

  const interactive =
    !options.scripted && process.stdin.isTTY && process.stdout.isTTY;
  const child = spawn(
    runtime,
    buildInstallToTuiContainerArgs({
      mode: "manual",
      image: options.image,
      interactive,
      innerArgs: options.scripted ? ["--scripted"] : [],
    }),
    {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal)
        reject(new Error(`manual_harness_container_signal:${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0)
    throw new Error(`manual_harness_container_exit:${exitCode}`);
}

export async function setupIsolatedInstalledRuntime(tempDir: string) {
  const home = path.join(tempDir, "home");
  const installDir = path.join(tempDir, "install");
  const agentDir = path.join(tempDir, "agent");
  const runtimeDir = path.join(tempDir, "runtime");
  const currentUser = os.userInfo().username || "rin";
  const userRecord = {
    name: currentUser,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    home,
    shell: "/bin/sh",
  };

  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  const managedNodeSourceRoot = path.join(tempDir, "managed-node-source");

  const release = {
    channel: "git",
    version: "123456789abc",
    branch: "main",
    ref: "123456789abcdef0123456789abcdef012345678",
    sourceLabel: "git main @ 123456789abc",
  };
  const managedNodeRuntime = fsUtils.publishManagedNodeRuntime(
    managedNodeSourceRoot,
    installDir,
    currentUser,
    false,
    { findSystemUser: () => userRecord },
  );
  assert.ok(managedNodeRuntime, "managed node runtime should be published");
  const publishedRuntime = fsUtils.publishInstalledRuntime(
    rootDir,
    installDir,
    currentUser,
    false,
    {
      findSystemUser: () => userRecord,
      release,
    },
  );
  const written = await persist.persistInstallerOutputs(
    {
      currentUser,
      targetUser: currentUser,
      installDir,
      provider: "openai",
      modelId: "gpt-test",
      thinkingLevel: "off",
      language: "en_US",
      setDefaultTarget: true,
      authData: { openai: { type: "api_key", key: "test-key" } },
      release,
      currentReleaseName: path.basename(publishedRuntime.releaseRoot),
      currentReleaseRoot: publishedRuntime.releaseRoot,
      elevated: false,
    },
    {
      findSystemUser: () => userRecord,
      ensureDir: fsUtils.ensureDir,
      readInstallerJson: fsUtils.readInstallerJson,
      writeJsonFileWithPrivilege: fsUtils.writeJsonFileWithPrivilege,
      writeJsonFile: fsUtils.writeJsonFile,
      launcherMetadataPathForUser: () =>
        fsUtils.launcherMetadataPathForUser(currentUser, () => home),
      readJsonFile: fsUtils.readJsonFile,
      writeLaunchersForUser: (_userName: string, dir: string, options: any) =>
        fsUtils.writeLaunchersForUser(currentUser, dir, () => home, {
          ...options,
          findSystemUser: () => userRecord,
        }),
      reconcileInstallerManifest: persist.reconcileInstallerManifest,
      runPrivileged: fsUtils.runPrivileged,
    },
  );

  const selfImproveStateDir = path.join(agentDir, "self_improve", "state");
  await fs.mkdir(selfImproveStateDir, { recursive: true });
  await fs.writeFile(
    path.join(selfImproveStateDir, "init-state.json"),
    `${JSON.stringify(
      {
        version: 2,
        completedAt: "2026-01-01T00:00:00.000Z",
        lastTrigger: "test_fixture",
        pending: false,
        initialized: true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
    RIN_DIR: agentDir,
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };

  return {
    home,
    installDir,
    agentDir,
    runtimeDir,
    env,
    rinPath: written.currentRinPath,
    daemonPath: path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-daemon",
      "daemon.js",
    ),
    tuiPath: path.join(
      installDir,
      "app",
      "current",
      "dist",
      "app",
      "rin-tui",
      "main.js",
    ),
    publishedRuntime,
    written,
  };
}

export async function runRin(
  rinPath: string,
  args: string[],
  env: Record<string, string>,
) {
  const result = await execFileAsync(rinPath, args, {
    cwd: rootDir,
    env,
  });
  return {
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

export async function waitForDoctorSocket(
  rinPath: string,
  env: Record<string, string>,
  expected: "yes" | "no",
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  let lastOutput = "";
  while (Date.now() - startedAt < timeoutMs) {
    const doctor = await runRin(rinPath, ["doctor", "--json"], env);
    lastOutput = doctor.stdout;
    const status = JSON.parse(doctor.stdout);
    if (status.socketReady === (expected === "yes")) return doctor;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed_out_waiting_for_socket_${expected}:\n${lastOutput}`);
}

async function stopDaemon(
  daemon: ReturnType<typeof spawn>,
  daemonExit: Promise<unknown>,
) {
  daemon.kill("SIGTERM");
  await Promise.race([
    daemonExit,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        daemon.kill("SIGKILL");
        resolve();
      }, 2500),
    ),
  ]).catch(() => undefined);
}

async function startInstalledDaemon(
  flow: Awaited<ReturnType<typeof setupIsolatedInstalledRuntime>>,
) {
  const daemon = spawn(process.execPath, [flow.daemonPath], {
    cwd: flow.installDir,
    env: flow.env,
    stdio: "ignore",
  });
  const daemonExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    daemon.once("error", reject);
    daemon.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForDoctorSocket(flow.rinPath, flow.env, "yes");
    return { daemon, daemonExit };
  } catch (error) {
    await stopDaemon(daemon, daemonExit);
    throw error;
  }
}

export async function withInstalledDaemon(
  flow: Awaited<ReturnType<typeof setupIsolatedInstalledRuntime>>,
  fn: (control: { restart(): Promise<void> }) => Promise<void>,
) {
  let active = await startInstalledDaemon(flow);
  const restart = async () => {
    const previous = active;
    await stopDaemon(previous.daemon, previous.daemonExit);
    await waitForDoctorSocket(flow.rinPath, flow.env, "no");
    active = await startInstalledDaemon(flow);
  };

  try {
    await fn({ restart });
  } finally {
    await stopDaemon(active.daemon, active.daemonExit);
  }
}

export async function assertInstalledRuntimeSmoke() {
  if (process.platform !== "linux") {
    throw new Error("install-to-TUI smoke currently requires linux");
  }
  if (!(await commandExists("script"))) {
    assert.fail(
      "missing util-linux script command in install-to-TUI container",
    );
  }

  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir);

    const version = await runRin(flow.rinPath, ["version"], flow.env);
    assert.equal(version.stdout.trim(), "123456789abc");

    const doctor = await runRin(flow.rinPath, ["doctor", "--json"], flow.env);
    const doctorStatus = JSON.parse(doctor.stdout);
    assert.equal(doctorStatus.installDir, flow.installDir);
    assert.equal(
      doctorStatus.socketPath,
      path.join(flow.runtimeDir, "rin-daemon", "daemon.sock"),
    );
    assert.equal(doctorStatus.socketReady, false);

    await assert.doesNotReject(() =>
      fs.access(flow.publishedRuntime.currentLink),
    );
    await assert.doesNotReject(() => fs.access(flow.written.settingsPath));
    await assert.doesNotReject(() => fs.access(flow.written.authPath));
    await assert.doesNotReject(() => fs.access(flow.written.launcherPath));
    await assert.doesNotReject(() => fs.access(flow.daemonPath));
    await assert.doesNotReject(() => fs.access(flow.tuiPath));

    await withInstalledDaemon(flow, async ({ restart }) => {
      const launcher = startPtyCommand(shellQuote(flow.rinPath), flow.env);
      let launcherResult: PtyCommandResult;
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(launcher.child.exitCode, null);
      } finally {
        launcherResult = await stopPtyCommand(launcher);
      }
      assertExpectedTuiExit(launcherResult);
      assertHealthyTuiOutput(launcher.getOutput());

      const tuiCommand = [process.execPath, flow.tuiPath]
        .map(shellQuote)
        .join(" ");
      const tui = startPtyCommand(tuiCommand, flow.env);
      const waitForOutput = async (
        pattern: RegExp,
        timeoutMs: number,
        offset = 0,
      ) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const visibleOutput = tui.getOutput().slice(offset);
          if (pattern.test(visibleOutput)) return visibleOutput;
          if (tui.child.exitCode !== null || tui.child.signalCode !== null) {
            assert.fail(
              `TUI exited before matching ${String(pattern)}:\n${visibleOutput}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.fail(
          `timed out waiting for ${String(pattern)}:\n${tui.getOutput().slice(offset)}`,
        );
      };

      let tuiResult: PtyCommandResult;
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(tui.child.exitCode, null);

        const restartOutputOffset = tui.getOutput().length;
        await restart();
        await waitForOutput(/Connecting/, 8000, restartOutputOffset);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(
          tui.child.exitCode,
          null,
          tui.getOutput().slice(restartOutputOffset),
        );
      } finally {
        tuiResult = await stopPtyCommand(tui);
      }
      assertExpectedTuiExit(tuiResult);
      assertHealthyTuiOutput(tui.getOutput());
    });
  });
}

export async function runManualInnerSession(options: { scripted?: boolean }) {
  if (process.platform !== "linux") {
    throw new Error("install-to-TUI manual harness currently requires linux");
  }

  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir);
    process.stderr.write(
      [
        "Rin isolated install-to-TUI harness",
        `  home: ${flow.home}`,
        `  installDir: ${flow.installDir}`,
        `  agentDir: ${flow.agentDir}`,
        `  socket: ${path.join(flow.runtimeDir, "rin-daemon", "daemon.sock")}`,
        "  note: the container filesystem is disposable; exiting cleans this environment.",
        "",
      ].join("\n"),
    );

    await withInstalledDaemon(flow, async () => {
      if (options.scripted) {
        const child = spawn(
          "script",
          ["-qfec", shellQuote(flow.rinPath), "/dev/null"],
          {
            cwd: rootDir,
            env: flow.env,
            stdio: ["pipe", "inherit", "inherit"],
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        child.stdin.write("\u0003");
        child.stdin.end();
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => {
            if (signal || code === 0 || code === 1 || code === 130) resolve();
            else reject(new Error(`manual_scripted_tui_exit:${code}`));
          });
        });
        return;
      }

      const child = spawn(flow.rinPath, [], {
        cwd: rootDir,
        env: flow.env,
        stdio: "inherit",
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (signal) reject(new Error(`manual_tui_signal:${signal}`));
          else if ((code ?? 0) === 0 || code === 1 || code === 130) resolve();
          else reject(new Error(`manual_tui_exit:${code}`));
        });
      });
    });
  });
}
