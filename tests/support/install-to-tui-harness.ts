import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import stripAnsi from "strip-ansi";

import { createTestSandbox } from "./test-sandbox.js";

const execFileAsync = promisify(execFile);

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const CONTAINER_SOURCE_ROOT = "/source/rin";
const CONTAINER_ROOT = "/workspace/rin";
const CONTAINER_COVERAGE_ROOT = "/coverage";

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
export const LOCAL_CI_CONTAINER_ENV = "RIN_SYSTEM_TEST_CONTAINER_INNER";
export const DEFAULT_CONTAINER_IMAGE = "rin-local-ci:latest";

export function isLocalCiContainerRun() {
  return process.env[LOCAL_CI_CONTAINER_ENV] === "1";
}

export function isInnerContainerRun() {
  return process.env[INNER_CONTAINER_ENV] === "1" || isLocalCiContainerRun();
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
    await execFileAsync("sh", ["-c", `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function findContainerRuntime() {
  for (const name of ["docker", "podman"]) {
    try {
      await execFileAsync(name, ["info"], {
        env: process.env,
        maxBuffer: 2 * 1024 * 1024,
      });
      return name;
    } catch {
      continue;
    }
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
  let timer: number | NodeJS.Timeout | undefined;
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
  coverageDir?: string;
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
          "tests/system/install-to-tui-user-flow.test.ts",
        ]
      : [
          "node",
          "--import",
          "tsx",
          "tests/system/install-to-tui-manual.ts",
          "--inner",
          ...(options.innerArgs || []),
        ];

  const innerInvocation = innerCommand.map(shellQuote).join(" ");
  const unprivilegedInvocation = `setpriv --reuid=1000 --regid=1000 --init-groups -- ${innerInvocation}`;
  const executeInner = options.coverageDir
    ? `${unprivilegedInvocation}; status=$?; chmod -R a+rwX ${shellQuote(CONTAINER_COVERAGE_ROOT)}; exit $status`
    : `exec ${unprivilegedInvocation}`;
  const innerScript = [
    `rm -rf ${shellQuote(CONTAINER_ROOT)} && mkdir -p ${shellQuote(CONTAINER_ROOT)}`,
    `tar --exclude='./node_modules' --exclude='./coverage' --exclude='./.git' -C ${shellQuote(CONTAINER_SOURCE_ROOT)} -cf - . | tar -C ${shellQuote(CONTAINER_ROOT)} -xf -`,
    `ln -s /opt/rin/node_modules ${shellQuote(path.posix.join(CONTAINER_ROOT, "node_modules"))}`,
    `cd ${shellQuote(CONTAINER_ROOT)}`,
    executeInner,
  ].join(" && ");
  const coverageArgs = options.coverageDir
    ? [
        "--mount",
        `type=bind,source=${path.resolve(options.coverageDir)},target=${CONTAINER_COVERAGE_ROOT}`,
        "-e",
        `NODE_V8_COVERAGE=${CONTAINER_COVERAGE_ROOT}`,
      ]
    : [];

  return [
    "run",
    "--rm",
    "--pull=never",
    ...(options.interactive ? ["-it"] : []),
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    "--tmpfs",
    "/tmp:exec,mode=1777",
    "--tmpfs",
    "/run:exec,mode=755",
    "--tmpfs",
    "/workspace:exec,mode=777",
    "--mount",
    `type=bind,source=${rootDir},target=${CONTAINER_SOURCE_ROOT},readonly`,
    ...coverageArgs,
    "-w",
    "/workspace",
    "-e",
    `${INNER_CONTAINER_ENV}=1`,
    "-e",
    "NO_COLOR=1",
    "--entrypoint",
    "/bin/sh",
    image,
    "-lc",
    innerScript,
  ];
}

async function rewriteContainerCoveragePaths(
  coverageDir: string,
  previousFiles: Set<string>,
) {
  const containerPrefix = "file:///workspace/rin/";
  const hostPrefix = pathToFileURL(`${rootDir}${path.sep}`).href;
  for (const name of await fs.readdir(coverageDir)) {
    if (previousFiles.has(name) || !name.endsWith(".json")) continue;
    const filePath = path.join(coverageDir, name);
    const raw = await fs.readFile(filePath, "utf8");
    const rewritten = raw
      .replaceAll(containerPrefix, hostPrefix)
      .replace(
        /file:\/\/\/[^"\\]*\/rin-install-tui-e2e-[^/"\\]+\/install\/app\/releases\/[^/"\\]+\/dist\//g,
        `${hostPrefix}dist/`,
      );
    if (rewritten !== raw) await fs.writeFile(filePath, rewritten, "utf8");
  }
}

export async function runInstallToTuiSmokeInContainer(
  options: { failOnUnavailableRuntime: boolean } = {
    failOnUnavailableRuntime: true,
  },
) {
  const runtime = await findContainerRuntime();
  if (!runtime) {
    const message =
      "missing docker or podman for isolated install-to-TUI smoke";
    if (options.failOnUnavailableRuntime) assert.fail(message);
    return { skipped: `runtime-unavailable: ${message}` };
  }

  try {
    await execFileAsync(runtime, ["info"], {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
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

  const coverageDir = process.env.NODE_V8_COVERAGE
    ? path.resolve(process.env.NODE_V8_COVERAGE)
    : "";
  if (coverageDir) {
    await fs.mkdir(coverageDir, { recursive: true });
    await fs.chmod(coverageDir, 0o777);
  }
  const previousCoverageFiles = new Set(
    coverageDir ? await fs.readdir(coverageDir) : [],
  );

  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = await execFileAsync(
      runtime,
      buildInstallToTuiContainerArgs({
        mode: "smoke-test",
        coverageDir: coverageDir || undefined,
      }),
      {
        cwd: rootDir,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    if (coverageDir) {
      await rewriteContainerCoveragePaths(coverageDir, previousCoverageFiles);
    }
    throw error;
  }
  if (coverageDir) {
    await rewriteContainerCoveragePaths(coverageDir, previousCoverageFiles);
  }
  const stdout = String(result.stdout || "");
  assert.match(stdout, /# pass 1/);
  return { stdout };
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
  const sandbox = await createTestSandbox(tempDir, {
    TERM: "xterm-256color",
  });
  const { home, agentDir, runtimeDir } = sandbox;
  const installDir = path.join(tempDir, "install");
  const currentUser = os.userInfo().username || "rin";
  const userRecord = {
    name: currentUser,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    home,
    shell: "/bin/sh",
  };

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
      readJsonFile: fsUtils.readJsonFileOrDefault,
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

  const env = sandbox.env;

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

async function stopPtyChild(
  child: ReturnType<typeof spawn>,
  exitPromise: Promise<unknown>,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]).catch(() => undefined);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]).catch(() => undefined);
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonOutput = "";
  for (const stream of [daemon.stdout, daemon.stderr]) {
    stream.on("data", (chunk) => {
      daemonOutput += String(chunk);
    });
  }
  const daemonExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    daemon.once("error", reject);
    daemon.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    await Promise.race([
      waitForDoctorSocket(flow.rinPath, flow.env, "yes", 15_000),
      daemonExit.then(({ code, signal }) => {
        throw new Error(
          `installed_daemon_exited:${code ?? "null"}:${signal ?? "null"}\n${daemonOutput}`,
        );
      }),
    ]);
    return { daemon, daemonExit };
  } catch (error) {
    await stopDaemon(daemon, daemonExit);
    const output = daemonOutput.trim();
    if (output) throw new Error(`${String(error)}\n${output}`);
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

export async function remapInstalledRuntimeCoverage() {
  const coverageDir = process.env.NODE_V8_COVERAGE;
  if (!coverageDir) return;
  await rewriteContainerCoveragePaths(path.resolve(coverageDir), new Set());
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
        assert.equal(launcher.child.exitCode, null, launcher.getOutput());
      } finally {
        launcherResult = await stopPtyCommand(launcher);
      }
      assertExpectedTuiExit(launcherResult);
      assertHealthyTuiOutput(launcher.getOutput());

      const tui = startPtyCommand(shellQuote(flow.rinPath), flow.env);

      let tuiResult: PtyCommandResult;
      try {
        const startupDeadline = Date.now() + 15_000;
        while (
          !/Rin can explain its own features/.test(tui.getOutput()) &&
          Date.now() < startupDeadline
        ) {
          assert.equal(tui.child.exitCode, null, tui.getOutput());
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.match(tui.getOutput(), /Rin can explain its own features/);

        const restartOutputOffset = tui.getOutput().length;
        await restart();
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

async function waitForVisiblePtyText(
  command: ReturnType<typeof startPtyCommand>,
  pattern: RegExp,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = stripAnsi(command.getOutput());
    if (pattern.test(visible)) return visible;
    if (command.child.exitCode !== null || command.child.signalCode !== null) {
      throw new Error(`ui_process_exited_before_text:${pattern}:${visible}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `ui_visible_text_timeout:${pattern}:${stripAnsi(command.getOutput())}`,
  );
}

export async function runUiOnlyTuiJourney() {
  if (process.platform !== "linux") {
    throw new Error("ui-only TUI journey currently requires linux");
  }
  if (!(await commandExists("script"))) {
    throw new Error("ui-only TUI journey requires util-linux script");
  }

  let result:
    | {
        startupScreen: string;
        hotkeysScreen: string;
        finalScreen: string;
        exit: PtyCommandResult;
      }
    | undefined;
  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir);
    await withInstalledDaemon(flow, async () => {
      const command = startPtyCommand(
        `stty cols 120 rows 40; exec ${shellQuote(flow.rinPath)}`,
        flow.env,
      );
      let exit: PtyCommandResult | undefined;
      try {
        const startupScreen = await waitForVisiblePtyText(
          command,
          /Rin can explain its own features/,
          15_000,
        );
        command.child.stdin.write("/hotkeys\r");
        const hotkeysScreen = await waitForVisiblePtyText(
          command,
          /Keyboard Shortcuts/,
          8_000,
        );
        command.child.stdin.write("/quit\r");
        exit = await waitForPtyExit(command.exitPromise, 8_000);
        if (!exit) throw new Error("ui_quit_timeout");
        result = {
          startupScreen,
          hotkeysScreen,
          finalScreen: stripAnsi(command.getOutput()),
          exit,
        };
      } finally {
        if (!exit) await stopPtyCommand(command);
      }
    });
  });
  if (!result) throw new Error("ui_journey_result_missing");
  return result;
}

export async function runFullscreenTuiJourney() {
  if (process.platform !== "linux") {
    throw new Error("fullscreen TUI journey currently requires linux");
  }
  if (!(await commandExists("script"))) {
    throw new Error("fullscreen TUI journey requires util-linux script");
  }

  let result:
    | {
        startupScreen: string;
        hotkeysScreen: string;
        scrolledScreen: string;
        finalScreen: string;
        exit: PtyCommandResult;
      }
    | undefined;
  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir);
    const settings = JSON.parse(
      await fs.readFile(flow.written.settingsPath, "utf8"),
    );
    settings.tuiMode = "fullscreen";
    await fs.writeFile(
      flow.written.settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );

    await withInstalledDaemon(flow, async () => {
      const command = startPtyCommand(
        `stty cols 120 rows 40; exec ${shellQuote(flow.rinPath)}`,
        flow.env,
      );
      let exit: PtyCommandResult | undefined;
      try {
        const startupScreen = await waitForVisiblePtyText(
          command,
          /Rin can explain its own features/,
          15_000,
        );
        command.child.stdin.write("/hotkeys\r");
        const hotkeysScreen = await waitForVisiblePtyText(
          command,
          /Keyboard Shortcuts/,
          8_000,
        );
        command.child.stdin.write("\u001b[6~");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(command.child.exitCode, null, command.getOutput());
        command.child.stdin.write("\u001b[5~");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(command.child.exitCode, null, command.getOutput());
        const scrolledScreen = stripAnsi(command.getOutput());

        command.child.stdin.write("/quit\r");
        exit = await waitForPtyExit(command.exitPromise, 8_000);
        if (!exit) throw new Error("fullscreen_ui_quit_timeout");
        result = {
          startupScreen,
          hotkeysScreen,
          scrolledScreen,
          finalScreen: stripAnsi(command.getOutput()),
          exit,
        };
      } finally {
        if (!exit) await stopPtyCommand(command);
      }
    });
  });
  if (!result) throw new Error("fullscreen_ui_journey_result_missing");
  return result;
}

async function waitForPtyOutputAfter(
  command: PtyCommand,
  offset: number,
  expected: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (command.getOutput().slice(offset).includes(expected)) return;
    if (command.child.exitCode !== null || command.child.signalCode !== null) {
      throw new Error(
        `ui_process_exited_before_output:${JSON.stringify(expected)}:${command.getOutput()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `ui_output_timeout:${JSON.stringify(expected)}:${command.getOutput()}`,
  );
}

async function selectTuiModeFromSettings(command: PtyCommand) {
  command.child.stdin.write("tui");
  await new Promise((resolve) => setTimeout(resolve, 100));
  command.child.stdin.write("\r");
}

export async function runHotSwitchTuiJourney() {
  if (process.platform !== "linux") {
    throw new Error("hot-switch TUI journey currently requires linux");
  }
  if (!(await commandExists("script"))) {
    throw new Error("hot-switch TUI journey requires util-linux script");
  }

  let result:
    | {
        startupScreen: string;
        fullscreenScreen: string;
        regularScreen: string;
        finalScreen: string;
        exit: PtyCommandResult;
      }
    | undefined;
  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir);
    await withInstalledDaemon(flow, async () => {
      const command = startPtyCommand(
        `stty cols 120 rows 40; exec ${shellQuote(flow.rinPath)}`,
        flow.env,
      );
      let exit: PtyCommandResult | undefined;
      try {
        const startupScreen = await waitForVisiblePtyText(
          command,
          /Rin can explain its own features/,
          15_000,
        );

        command.child.stdin.write("/settings\r");
        await waitForVisiblePtyText(command, /Type to search/, 8_000);
        const fullscreenOffset = command.getOutput().length;
        await selectTuiModeFromSettings(command);
        await waitForPtyOutputAfter(
          command,
          fullscreenOffset,
          "\u001b[?1049h",
          8_000,
        );

        await new Promise((resolve) => setTimeout(resolve, 300));
        command.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 100));
        command.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 100));
        command.child.stdin.write("/hotkeys\r");
        const fullscreenScreen = await waitForVisiblePtyText(
          command,
          /Slash commands/,
          8_000,
        );
        command.child.stdin.write("\u001b[6~");
        await new Promise((resolve) => setTimeout(resolve, 250));
        command.child.stdin.write("\u001b[5~");
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(command.child.exitCode, null, command.getOutput());

        command.child.stdin.write("/settings\r");
        await new Promise((resolve) => setTimeout(resolve, 200));
        const regularOffset = command.getOutput().length;
        await selectTuiModeFromSettings(command);
        await waitForPtyOutputAfter(
          command,
          regularOffset,
          "\u001b[?1049l",
          8_000,
        );
        const regularScreen = stripAnsi(command.getOutput());

        await new Promise((resolve) => setTimeout(resolve, 300));
        command.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 100));
        command.child.stdin.write("\u001b");
        await new Promise((resolve) => setTimeout(resolve, 100));
        command.child.stdin.write("/quit\r");
        exit = await waitForPtyExit(command.exitPromise, 8_000);
        if (!exit) throw new Error("hot_switch_ui_quit_timeout");
        result = {
          startupScreen,
          fullscreenScreen,
          regularScreen,
          finalScreen: stripAnsi(command.getOutput()),
          exit,
        };
      } finally {
        if (!exit) await stopPtyCommand(command);
      }
    });
  });
  if (!result) throw new Error("hot_switch_ui_journey_result_missing");
  return result;
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
        const installedNodePath = path.join(
          flow.installDir,
          "runtime",
          "node",
          "current",
          "bin",
          "node",
        );
        const child = spawn(
          "script",
          [
            "-qfec",
            `stty cols 120 rows 40; exec ${shellQuote(installedNodePath)} ${shellQuote(flow.tuiPath)}`,
            "/dev/null",
          ],
          {
            cwd: rootDir,
            env: flow.env,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
        });
        const exitPromise = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        try {
          const renderDeadline = Date.now() + 8000;
          while (
            Date.now() < renderDeadline &&
            !(output.length > 20 && output.includes("\u001b["))
          ) {
            if (child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (
            child.exitCode !== null ||
            output.length <= 20 ||
            !output.includes("\u001b[")
          ) {
            throw new Error(
              `manual_scripted_tui_no_render:${JSON.stringify(output)}`,
            );
          }
          child.stdin.write("\u0003");
          child.stdin.end();
          const exitResult = await Promise.race([
            exitPromise,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("manual_scripted_tui_exit_timeout")),
                8000,
              ),
            ),
          ]);
          if (
            exitResult.signal !== "SIGINT" &&
            exitResult.code !== 0 &&
            exitResult.code !== 130
          ) {
            throw new Error(
              `manual_scripted_tui_exit:${exitResult.code}:${exitResult.signal || "none"}:${JSON.stringify(output)}`,
            );
          }
        } finally {
          await stopPtyChild(child, exitPromise);
        }
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
