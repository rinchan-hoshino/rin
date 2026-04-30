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
const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, "package.json"), "utf8"),
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
  failOnMissingRuntime: boolean;
}) {
  const runtime = await findContainerRuntime();
  if (!runtime) {
    if (options.failOnMissingRuntime) {
      assert.fail("missing docker or podman for isolated install-to-TUI smoke");
    }
    return {
      skipped: "missing docker or podman for isolated install-to-TUI smoke",
    };
  }

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

  const release = {
    channel: "git",
    version: "install-to-tui-test",
    ref: "install-to-tui-test",
    sourceLabel: "install-to-tui-test",
  };
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
      language: "en",
      setDefaultTarget: true,
      chatConfig: {},
      authData: { openai: { type: "api_key", key: "test-key" } },
      release,
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

  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, "bus")}`,
    RIN_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    RIN_DAEMON_SOCKET_PATH: path.join(runtimeDir, "daemon.sock"),
    RIN_DAEMON_SHUTDOWN_GRACE_MS: "250",
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
    const doctor = await runRin(rinPath, ["doctor"], env);
    lastOutput = doctor.stdout;
    if (doctor.stdout.includes(`socketReady=${expected}`)) return doctor;
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

export async function withInstalledDaemon(
  flow: Awaited<ReturnType<typeof setupIsolatedInstalledRuntime>>,
  fn: () => Promise<void>,
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
    await fn();
  } finally {
    await stopDaemon(daemon, daemonExit);
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
    assert.equal(version.stdout.trim(), String(packageJson.version || "0.0.0"));

    const doctor = await runRin(flow.rinPath, ["doctor"], flow.env);
    assert.match(doctor.stdout, new RegExp(`installDir=${flow.installDir}`));
    assert.match(
      doctor.stdout,
      new RegExp(`socketPath=${flow.env.RIN_DAEMON_SOCKET_PATH}`),
    );
    assert.match(doctor.stdout, /socketReady=no/);

    await assert.doesNotReject(() =>
      fs.access(flow.publishedRuntime.currentLink),
    );
    await assert.doesNotReject(() => fs.access(flow.written.settingsPath));
    await assert.doesNotReject(() => fs.access(flow.written.authPath));
    await assert.doesNotReject(() => fs.access(flow.written.launcherPath));
    await assert.doesNotReject(() => fs.access(flow.daemonPath));
    await assert.doesNotReject(() => fs.access(flow.tuiPath));

    await withInstalledDaemon(flow, async () => {
      const child = spawn(
        "script",
        ["-qfec", shellQuote(flow.rinPath), "/dev/null"],
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
        await new Promise((resolve) => setTimeout(resolve, 2000));
        assert.equal(child.exitCode, null);
        child.stdin.write("\u0003");
        child.stdin.end();

        const result = await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("install_to_tui_smoke_timeout")),
              8000,
            ),
          ),
        ]);

        assert.ok(
          result.code === 0 ||
            result.code === 1 ||
            result.code === 130 ||
            result.signal === "SIGINT",
        );
        assert.doesNotMatch(output, /rin_not_installed/);
        assert.doesNotMatch(output, /Entering temporary maintenance mode/);
        assert.doesNotMatch(output, /Cannot find module|MODULE_NOT_FOUND/);
        assert.doesNotMatch(output, /TypeError|Cannot read properties/);
      } finally {
        child.kill("SIGTERM");
      }
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
        `  socket: ${flow.env.RIN_DAEMON_SOCKET_PATH}`,
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
