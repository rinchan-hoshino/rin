import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
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
const chatMain = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href
);
const cronModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "cron.js"))
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
  smokeTestFile?: string;
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
          options.smokeTestFile ||
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
  options: {
    failOnUnavailableRuntime?: boolean;
    testFile?: string;
  } = {},
) {
  const failOnUnavailableRuntime = options.failOnUnavailableRuntime ?? true;
  const runtime = await findContainerRuntime();
  if (!runtime) {
    const message =
      "missing docker or podman for isolated install-to-TUI smoke";
    if (failOnUnavailableRuntime) assert.fail(message);
    return { skipped: `runtime-unavailable: ${message}` };
  }

  try {
    await execFileAsync(runtime, ["info"], {
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error: any) {
    if (failOnUnavailableRuntime) throw error;
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
        smokeTestFile: options.testFile,
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

async function installJourneyExtension(installDir: string) {
  const extensionsDir = path.join(installDir, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });
  const extensionPath = path.join(extensionsDir, "k14-journey.ts");
  await fs.writeFile(
    extensionPath,
    `export default function journeyExtension(pi) {
  pi.registerCommand("journey-smoke", {
    description: "Prove that the optional journey extension loaded",
    handler: async (_args, context) => context.ui.notify("JOURNEY_EXTENSION_READY", "info"),
  });
}
`,
    "utf8",
  );
  return extensionPath;
}

async function installReminderPlatformExtension(installDir: string) {
  const extensionsDir = path.join(installDir, "extensions");
  const deliveryPath = path.join(installDir, "journey-reminder-delivery.jsonl");
  await fs.mkdir(extensionsDir, { recursive: true });
  const extensionPath = path.join(extensionsDir, "k14-reminder-platform.mjs");
  await fs.writeFile(
    extensionPath,
    `import fs from "node:fs/promises";

export default function reminderPlatformExtension(pi) {
  pi.events.emit("rin.chat.platform.v1", {
    apiVersion: 1,
    platform: "journey",
    create(input) {
      const bot = {
        platform: "journey",
        selfId: "bot",
        status: 1,
        async sendMessage(chatId, content, options) {
          await fs.appendFile(
            ${JSON.stringify(deliveryPath)},
            JSON.stringify({ chatId, content, options }) + "\\n",
            "utf8",
          );
          return ["journey-delivery-1"];
        },
      };
      return {
        bot,
        start() {
          input.updateStatus(bot, 1);
        },
        stop() {},
      };
    },
  });
}
`,
    "utf8",
  );
  return { deliveryPath, extensionPath };
}

async function startJourneyProvider() {
  const requests: string[] = [];
  const toolResults: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let prompt = "";
      let lastRole = "";
      let lastContent = "";
      try {
        const payload = JSON.parse(body);
        const messages = payload.messages || [];
        const user = [...messages]
          .reverse()
          .find((message) => message.role === "user");
        const content = user?.content;
        prompt =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
              : "";
        const last = messages.at(-1);
        lastRole = last?.role || "";
        lastContent =
          typeof last?.content === "string"
            ? last.content
            : Array.isArray(last?.content)
              ? last.content
                  .map((part) => part.text || part.content || "")
                  .join("\n")
              : "";
      } catch {}
      requests.push(prompt);
      if (lastRole === "tool") toolResults.push(lastContent);
      const chunk = (choices: unknown[]) =>
        `data: ${JSON.stringify({
          id: "journey-response",
          object: "chat.completion.chunk",
          created: 0,
          model: "journey-model",
          choices,
        })}\n\n`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (
        prompt.includes("recall journey memory ORCHID-K14-731") &&
        lastRole !== "tool"
      ) {
        response.write(
          chunk([
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-recall-k14",
                    type: "function",
                    function: {
                      name: "recall",
                      arguments: JSON.stringify({ query: "ORCHID-K14-731" }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
        );
        response.write(
          chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
        );
      } else {
        const text =
          lastRole === "tool"
            ? lastContent.includes("ORCHID-K14-731")
              ? "RECALL_FOUND_ORCHID_K14_731"
              : "RECALL_MISSING_ORCHID_K14_731"
            : prompt.includes("store journey memory ORCHID-K14-731")
              ? "MEMORY_STORED"
              : prompt.includes("second journey prompt")
                ? "JOURNEY_REPLY_2"
                : "JOURNEY_REPLY_1";
        response.write(
          chunk([
            {
              index: 0,
              delta: { role: "assistant", content: text },
              finish_reason: null,
            },
          ]),
        );
        response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    toolResults,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function setupIsolatedInstalledRuntime(
  tempDir: string,
  options: {
    journeyExtension?: boolean;
    journeyProviderBaseUrl?: string;
  } = {},
) {
  const sandbox = await createTestSandbox(tempDir, {
    TERM: "xterm-256color",
  });
  const { home, agentDir: sandboxAgentDir, runtimeDir } = sandbox;
  const installDir = path.join(tempDir, "install");
  const agentDir = options.journeyProviderBaseUrl
    ? installDir
    : sandboxAgentDir;
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
      provider: options.journeyProviderBaseUrl ? "k14-journey" : "openai",
      modelId: options.journeyProviderBaseUrl ? "journey-model" : "gpt-test",
      thinkingLevel: "off",
      setDefaultTarget: true,
      authData: options.journeyProviderBaseUrl
        ? {}
        : { openai: { type: "api_key", key: "test-key" } },
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

  const journeyExtensionPath = options.journeyExtension
    ? await installJourneyExtension(installDir)
    : undefined;
  if (options.journeyProviderBaseUrl) {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      `${JSON.stringify(
        {
          providers: {
            "k14-journey": {
              baseUrl: options.journeyProviderBaseUrl,
              api: "openai-completions",
              apiKey: "test-key",
              models: [
                {
                  id: "journey-model",
                  name: "Journey Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128_000,
                  maxTokens: 1_024,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

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
    ...sandbox.env,
    RIN_DIR: agentDir,
    RIN_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
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
    journeyExtensionPath,
  };
}

export async function runRin(
  rinPath: string,
  args: string[],
  env: Record<string, string>,
) {
  try {
    const result = await execFileAsync(rinPath, args, {
      cwd: rootDir,
      env,
      timeout: 30_000,
    });
    return {
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
    };
  } catch (error: any) {
    throw new Error(
      [String(error), error?.stdout, error?.stderr].filter(Boolean).join("\n"),
    );
  }
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
    return { daemon, daemonExit, getOutput: () => daemonOutput };
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
  } catch (error) {
    const output = active.getOutput().trim();
    throw new Error(
      output ? `${String(error)}\n[daemon]\n${output}` : String(error),
    );
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

  const provider = await startJourneyProvider();
  try {
    await withIsolatedTempDir(async (tempDir) => {
      const flow = await setupIsolatedInstalledRuntime(tempDir, {
        journeyProviderBaseUrl: provider.baseUrl,
      });

      const version = await runRin(flow.rinPath, ["version"], flow.env);
      assert.equal(version.stdout.trim(), "123456789abc");

      const modelArgs = ["--model", "k14-journey/journey-model"];
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
        const tuiInvocation = [flow.rinPath, ...modelArgs]
          .map(shellQuote)
          .join(" ");
        const tui = startPtyCommand(tuiInvocation, flow.env);

        let tuiResult: PtyCommandResult;
        try {
          await waitForVisiblePtyText(
            tui,
            /Rin can explain its own features/,
            15_000,
          );

          tui.child.stdin.write("first journey prompt\r");
          await waitForVisiblePtyText(tui, /JOURNEY_REPLY_1/, 15_000);

          const restartOutputOffset = tui.getOutput().length;
          await restart();
          await waitForVisiblePtyText(
            tui,
            /journey-model daemon/,
            15_000,
            restartOutputOffset,
          );
          assert.equal(
            tui.child.exitCode,
            null,
            tui.getOutput().slice(restartOutputOffset),
          );
          tui.child.stdin.write("second journey prompt\r");
          await waitForVisiblePtyText(tui, /JOURNEY_REPLY_2/, 15_000);
        } finally {
          tuiResult = await stopPtyCommand(tui);
        }
        assertExpectedTuiExit(tuiResult);
        assertHealthyTuiOutput(tui.getOutput());
      });
    });
    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[0] || "", /first journey prompt$/);
    assert.match(provider.requests[1] || "", /second journey prompt$/);
  } finally {
    await provider.close();
  }
}

export async function assertRecallAcrossSessions() {
  if (process.platform !== "linux") {
    throw new Error("recall user journey currently requires linux");
  }
  if (!(await commandExists("script"))) {
    throw new Error("recall user journey requires util-linux script");
  }

  const provider = await startJourneyProvider();
  try {
    await withIsolatedTempDir(async (tempDir) => {
      const flow = await setupIsolatedInstalledRuntime(tempDir, {
        journeyProviderBaseUrl: provider.baseUrl,
      });
      await withInstalledDaemon(flow, async () => {
        const command = startPtyCommand(
          [flow.rinPath, "--model", "k14-journey/journey-model"]
            .map(shellQuote)
            .join(" "),
          flow.env,
        );
        let result: PtyCommandResult;
        try {
          await waitForVisiblePtyText(
            command,
            /Rin can explain its own features/,
            15_000,
          );
          command.child.stdin.write("store journey memory ORCHID-K14-731\r");
          await waitForVisiblePtyText(command, /MEMORY_STORED/, 15_000);
          command.child.stdin.write("/new\r");
          await waitForVisiblePtyText(command, /New session started/, 8_000);
          command.child.stdin.write("recall journey memory ORCHID-K14-731\r");
          await waitForVisiblePtyText(
            command,
            /RECALL_FOUND_ORCHID_K14_731/,
            15_000,
          );
        } finally {
          result = await stopPtyCommand(command);
        }
        assertExpectedTuiExit(result);
        assertHealthyTuiOutput(command.getOutput());
      });
    });
    assert.ok(
      provider.requests.some((prompt) =>
        prompt.includes("store journey memory ORCHID-K14-731"),
      ),
    );
    assert.ok(
      provider.requests.some((prompt) =>
        prompt.includes("recall journey memory ORCHID-K14-731"),
      ),
    );
    assert.equal(provider.toolResults.length, 1);
    assert.match(provider.toolResults[0] || "", /ORCHID-K14-731/);
  } finally {
    await provider.close();
  }
}

async function waitForVisiblePtyText(
  command: ReturnType<typeof startPtyCommand>,
  pattern: RegExp,
  timeoutMs: number,
  outputOffset = 0,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = stripAnsi(command.getOutput().slice(outputOffset));
    if (pattern.test(visible)) return visible;
    if (command.child.exitCode !== null || command.child.signalCode !== null) {
      throw new Error(`ui_process_exited_before_text:${pattern}:${visible}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `ui_visible_text_timeout:${pattern}:${stripAnsi(
      command.getOutput().slice(outputOffset),
    )}`,
  );
}

export async function assertScheduledReminderDelivery() {
  if (process.platform !== "linux") {
    throw new Error("scheduled reminder journey currently requires linux");
  }

  await withIsolatedTempDir(async (tempDir) => {
    const sandbox = await createTestSandbox(tempDir);
    const { agentDir } = sandbox;
    const { deliveryPath, extensionPath } =
      await installReminderPlatformExtension(agentDir);
    const settingsPath = path.join(agentDir, "settings.json");
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify({ chat: { journey: { enabled: true } } }, null, 2)}\n`,
      "utf8",
    );

    const previousEnvironment = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(sandbox.env)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
    const previousCwd = process.cwd();
    let bridge:
      | Awaited<ReturnType<typeof chatMain.startChatBridge>>
      | undefined;
    let scheduler: InstanceType<typeof cronModule.CronScheduler> | undefined;
    try {
      bridge = await chatMain.startChatBridge({
        additionalExtensionPaths: [extensionPath],
        settingsPath,
        hosted: true,
        commandRows: [],
      });
      scheduler = new cronModule.CronScheduler({
        agentDir,
        chat: bridge,
      });
      scheduler.start();
      const taskId = "cron_k14_reminder_delivery";
      const created = scheduler.upsertTask({
        id: taskId,
        name: "K14 reminder journey",
        trigger: { runAt: new Date(Date.now() + 250).toISOString() },
        frontend: { kind: "chat", key: "journey/bot:owner" },
        session: { mode: "none" },
        target: {
          kind: "shell_command",
          command: "printf REMINDER_DELIVERED_K14",
        },
      });
      assert.equal(created.id, taskId);

      const deadline = Date.now() + 10_000;
      let delivered = "";
      while (Date.now() < deadline) {
        try {
          delivered = await fs.readFile(deliveryPath, "utf8");
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (delivered.includes("REMINDER_DELIVERED_K14")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(delivered, /REMINDER_DELIVERED_K14/);
      assert.match(delivered, /"chatId":"owner"/);
      const finished = scheduler.getTask(taskId);
      assert.equal(finished.enabled, false);
      assert.match(finished.completedAt || "", /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      scheduler?.stop();
      await bridge?.stop();
      process.chdir(previousCwd);
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

export async function assertOptionalExtensionSmoke() {
  if (process.platform !== "linux") {
    throw new Error("optional extension smoke currently requires linux");
  }
  if (!(await commandExists("script"))) {
    throw new Error("optional extension smoke requires util-linux script");
  }

  await withIsolatedTempDir(async (tempDir) => {
    const flow = await setupIsolatedInstalledRuntime(tempDir, {
      journeyExtension: true,
    });
    assert.ok(flow.journeyExtensionPath);
    await withInstalledDaemon(flow, async () => {
      const command = startPtyCommand(
        [flow.rinPath, "--extension", flow.journeyExtensionPath]
          .map(shellQuote)
          .join(" "),
        flow.env,
      );
      let result: PtyCommandResult;
      try {
        await waitForVisiblePtyText(
          command,
          /Rin can explain its own features/,
          15_000,
        );
        command.child.stdin.write("/journey-smoke\r");
        await waitForVisiblePtyText(command, /JOURNEY_EXTENSION_READY/, 8_000);
      } finally {
        result = await stopPtyCommand(command);
      }
      assertExpectedTuiExit(result);
      assertHealthyTuiOutput(command.getOutput());
    });
  });
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
