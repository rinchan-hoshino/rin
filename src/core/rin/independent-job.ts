import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { RIN_DAEMON_WORKER_OWNER_ENV } from "../rin-lib/profile.js";
import { managedSystemdUnitName } from "../rin-install/paths.js";

type JobStatus = {
  state: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
};

export type IndependentJobKind = "update" | "restart";

export type IndependentJobRecord = {
  version: 1;
  kind: IndependentJobKind;
  id: string;
  targetUser: string;
  installDir: string;
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  executorEntryPath: string;
  waitForPid?: number;
  status: JobStatus;
  launcher?: {
    kind: "launchd";
    domain: string;
    label: string;
    servicePath: string;
  };
};

export type IndependentJobLaunchResult = {
  detached: boolean;
  launcher: "foreground" | "systemd" | "launchd" | "windows-detached";
  id: string;
  jobPath: string;
  logHint: string;
};

export type IndependentJobLauncherDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: typeof fs.readFileSync;
  mkdir?: typeof fs.mkdirSync;
  chmod?: typeof fs.chmodSync;
  writeFile?: typeof fs.writeFileSync;
  rename?: typeof fs.renameSync;
  unlink?: typeof fs.unlinkSync;
  runSync?: typeof spawnSync;
  spawnProcess?: typeof spawn;
  randomId?: () => string;
  now?: () => string;
};

export type IndependentJobExecutorDependencies = {
  spawnProcess?: typeof spawn;
  now?: () => string;
  writeRecord?: (jobPath: string, record: IndependentJobRecord) => void;
  cleanupLauncher?: (record: IndependentJobRecord) => void;
  waitForProcessExit?: (pid: number) => Promise<void>;
};

function safeString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function requireSafeIdentifier(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`rin_independent_job_invalid:${label}`);
  }
  return trimmed;
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function powershellLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createJobId(
  kind: IndependentJobKind,
  targetUser: string,
  randomId: () => string,
) {
  const stamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  const suffix =
    randomId()
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 10) || "job";
  const user = targetUser.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `rin-${kind}-${user}-${stamp}-${suffix}`;
}

export function independentJobPath(
  installDir: string,
  kind: IndependentJobKind,
  id: string,
) {
  return path.join(installDir, "jobs", kind, `${id}.json`);
}

export function isDaemonOwnedInvocation(
  targetUser: string,
  dependencies: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    readFile?: typeof fs.readFileSync;
  } = {},
) {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const readFile = dependencies.readFile ?? fs.readFileSync;
  const explicitOwner = safeString(env[RIN_DAEMON_WORKER_OWNER_ENV]).trim();
  if (explicitOwner && explicitOwner === targetUser) return true;
  if (platform !== "linux") return false;
  try {
    const cgroup = String(readFile("/proc/self/cgroup", "utf8"));
    const unit = managedSystemdUnitName(targetUser);
    return cgroup.split(/\r?\n/).some((line) => {
      const cgroupPath = line.slice(line.lastIndexOf(":") + 1);
      return (
        cgroupPath.includes(`/${unit}/`) || cgroupPath.endsWith(`/${unit}`)
      );
    });
  } catch {
    return false;
  }
}

export function forwardedIndependentJobEnvironment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const forwarded: Record<string, string> = {
    HOME: safeString(env.HOME),
    USER: safeString(env.USER),
    LOGNAME: safeString(env.LOGNAME),
    PATH:
      safeString(env.PATH) || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    RIN_DIR: safeString(env.RIN_DIR),
  };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    const value = safeString(env[key]);
    if (value) forwarded[key] = value;
  }
  return forwarded;
}

export function writeIndependentJobRecord(
  jobPath: string,
  record: IndependentJobRecord,
) {
  fs.mkdirSync(path.dirname(jobPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(jobPath), 0o700);
  } catch {}
  const tempPath = `${jobPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tempPath, jobPath);
  try {
    fs.chmodSync(jobPath, 0o600);
  } catch {}
}

export function readIndependentJobRecord(
  jobPath: string,
  expectedKind?: IndependentJobKind,
): IndependentJobRecord {
  const parsed = JSON.parse(
    fs.readFileSync(jobPath, "utf8"),
  ) as IndependentJobRecord;
  if (
    parsed.version !== 1 ||
    !parsed.id ||
    !parsed.command ||
    !Array.isArray(parsed.args)
  ) {
    throw new Error("rin_independent_job_invalid");
  }
  if (parsed.kind === undefined && expectedKind === "update")
    parsed.kind = "update";
  if (parsed.kind !== "update" && parsed.kind !== "restart") {
    throw new Error("rin_independent_job_kind_invalid");
  }
  if (expectedKind && parsed.kind !== expectedKind) {
    throw new Error(
      `rin_independent_job_kind_mismatch:${expectedKind}:${parsed.kind}`,
    );
  }
  return parsed;
}

function runChecked(
  command: string,
  args: string[],
  runSync: typeof spawnSync,
  env: NodeJS.ProcessEnv,
) {
  const result = runSync(command, args, { stdio: "ignore", env });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `rin_independent_job_launcher_failed:${command}:${result.status}`,
    );
  }
}

function launchLinuxJob(
  record: IndependentJobRecord,
  jobPath: string,
  runSync: typeof spawnSync,
  env: NodeJS.ProcessEnv,
): IndependentJobLaunchResult {
  const unit = record.id;
  const args = [
    "--user",
    "--unit",
    unit,
    "--collect",
    "--property",
    "Type=exec",
    "--property",
    "TimeoutStartSec=infinity",
    "--property",
    "TimeoutStopSec=30",
    record.command,
    record.executorEntryPath,
    jobPath,
  ];
  runChecked("systemd-run", args, runSync, env);
  return {
    detached: true,
    launcher: "systemd",
    id: record.id,
    jobPath,
    logHint: `journalctl --user -u ${unit} -f`,
  };
}

function launchMacJob(
  record: IndependentJobRecord,
  jobPath: string,
  runSync: typeof spawnSync,
  env: NodeJS.ProcessEnv,
  writeFile: typeof fs.writeFileSync,
  chmod: typeof fs.chmodSync,
): IndependentJobLaunchResult {
  if (typeof process.getuid !== "function")
    throw new Error("rin_independent_job_uid_unavailable");
  const uid = process.getuid();
  const suffix = record.id.replace(/[^A-Za-z0-9.-]/g, "-").slice(-80);
  const label = `moe.hoshinorin.rin.${record.kind}-${suffix}`;
  const servicePath = path.join(
    os.tmpdir(),
    `rin-${record.kind}-${suffix}.plist`,
  );
  const logPath = path.join(os.tmpdir(), `rin-${record.kind}-${suffix}.log`);
  const environmentEntries = Object.entries(record.environment)
    .filter(([, value]) => value !== "")
    .map(
      ([key, value]) =>
        `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`,
    )
    .join("");
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xmlEscape(label)}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${xmlEscape(record.command)}</string>`,
    `<string>${xmlEscape(record.executorEntryPath)}</string>`,
    `<string>${xmlEscape(jobPath)}</string>`,
    "</array>",
    `<key>WorkingDirectory</key><string>${xmlEscape(record.cwd)}</string>`,
    `<key>EnvironmentVariables</key><dict>${environmentEntries}</dict>`,
    "<key>RunAtLoad</key><true/>",
    `<key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>`,
    `<key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
  writeFile(servicePath, plist, { mode: 0o600 });
  try {
    chmod(servicePath, 0o600);
  } catch {}
  record.launcher = {
    kind: "launchd",
    domain: `gui/${uid}`,
    label,
    servicePath,
  };
  writeIndependentJobRecord(jobPath, record);
  runSync("launchctl", ["bootout", `gui/${uid}/${label}`], {
    stdio: "ignore",
    env,
  });
  runChecked(
    "launchctl",
    ["bootstrap", `gui/${uid}`, servicePath],
    runSync,
    env,
  );
  runChecked("launchctl", ["kickstart", `gui/${uid}/${label}`], runSync, env);
  return {
    detached: true,
    launcher: "launchd",
    id: record.id,
    jobPath,
    logHint: logPath,
  };
}

async function launchWindowsJob(
  record: IndependentJobRecord,
  jobPath: string,
  env: NodeJS.ProcessEnv,
  spawnProcess: typeof spawn,
): Promise<IndependentJobLaunchResult> {
  const script = [
    `$job = Start-Process -FilePath ${powershellLiteral(record.command)}`,
    ` -ArgumentList @(${[record.executorEntryPath, jobPath].map(powershellLiteral).join(",")})`,
    ` -WorkingDirectory ${powershellLiteral(record.cwd)}`,
    " -WindowStyle Hidden -PassThru;",
    "if ($null -eq $job) { exit 1 }",
  ].join("");
  const child = spawnProcess(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    { detached: true, stdio: "ignore", env },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return {
    detached: true,
    launcher: "windows-detached",
    id: record.id,
    jobPath,
    logHint: jobPath,
  };
}

export async function launchIndependentJob(
  options: {
    kind: IndependentJobKind;
    targetUser: string;
    installDir: string;
    nodePath: string;
    payloadEntryPath: string;
    executorEntryPath: string;
    payloadArgs: string[];
    cwd: string;
    waitForPid?: number;
  },
  dependencies: IndependentJobLauncherDependencies = {},
): Promise<IndependentJobLaunchResult> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const readFile = dependencies.readFile ?? fs.readFileSync;
  const mkdir = dependencies.mkdir ?? fs.mkdirSync;
  const chmod = dependencies.chmod ?? fs.chmodSync;
  const writeFile = dependencies.writeFile ?? fs.writeFileSync;
  const rename = dependencies.rename ?? fs.renameSync;
  const unlink = dependencies.unlink ?? fs.unlinkSync;
  const runSync = dependencies.runSync ?? spawnSync;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const randomId =
    dependencies.randomId ?? (() => randomBytes(6).toString("hex"));
  const now = dependencies.now ?? (() => new Date().toISOString());
  const id = createJobId(options.kind, options.targetUser, randomId);
  const jobPath = independentJobPath(options.installDir, options.kind, id);
  if (
    !isDaemonOwnedInvocation(options.targetUser, { platform, env, readFile })
  ) {
    return {
      detached: false,
      launcher: "foreground",
      id,
      jobPath,
      logHint: jobPath,
    };
  }
  const jobDir = path.dirname(jobPath);
  mkdir(jobDir, { recursive: true, mode: 0o700 });
  try {
    chmod(jobDir, 0o700);
  } catch {}
  const record: IndependentJobRecord = {
    version: 1,
    kind: options.kind,
    id,
    targetUser: requireSafeIdentifier(options.targetUser, "target_user"),
    installDir: path.resolve(options.installDir),
    command: path.resolve(options.nodePath),
    args: [path.resolve(options.payloadEntryPath), ...options.payloadArgs],
    cwd: path.resolve(options.cwd),
    environment: forwardedIndependentJobEnvironment(env),
    executorEntryPath: path.resolve(options.executorEntryPath),
    ...(options.waitForPid ? { waitForPid: options.waitForPid } : {}),
    status: { state: "queued", createdAt: now() },
  };
  const writeRecord = (
    targetPath: string,
    targetRecord: IndependentJobRecord,
  ) => {
    const temporary = `${targetPath}.${process.pid}.tmp`;
    writeFile(temporary, `${JSON.stringify(targetRecord, null, 2)}\n`, {
      mode: 0o600,
    });
    rename(temporary, targetPath);
    try {
      chmod(targetPath, 0o600);
    } catch {}
  };
  writeRecord(jobPath, record);
  try {
    if (platform === "linux")
      return launchLinuxJob(record, jobPath, runSync, env);
    if (platform === "darwin")
      return launchMacJob(record, jobPath, runSync, env, writeFile, chmod);
    if (platform === "win32")
      return await launchWindowsJob(record, jobPath, env, spawnProcess);
    throw new Error(`rin_independent_job_platform_unsupported:${platform}`);
  } catch (error) {
    try {
      unlink(jobPath);
    } catch {}
    throw error;
  }
}

async function waitForPidExit(pid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`rin_independent_job_parent_exit_timeout:${pid}`);
}

function cleanupLauncher(record: IndependentJobRecord) {
  const launcher = record.launcher;
  if (!launcher || launcher.kind !== "launchd") return;
  try {
    fs.unlinkSync(launcher.servicePath);
  } catch {}
  spawnSync("launchctl", ["bootout", `${launcher.domain}/${launcher.label}`], {
    stdio: "ignore",
  });
}

export async function runIndependentJobExecutor(
  jobPath: string,
  options: {
    expectedKind: IndependentJobKind;
    childEnvironment?: (record: IndependentJobRecord) => NodeJS.ProcessEnv;
  },
  dependencies: IndependentJobExecutorDependencies = {},
) {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const writeRecord = dependencies.writeRecord ?? writeIndependentJobRecord;
  const cleanup = dependencies.cleanupLauncher ?? cleanupLauncher;
  const waitForProcessExit = dependencies.waitForProcessExit ?? waitForPidExit;
  const record = readIndependentJobRecord(jobPath, options.expectedKind);
  record.status = {
    ...record.status,
    state: "running",
    startedAt: now(),
    pid: process.pid,
  };
  writeRecord(jobPath, record);
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    if (record.waitForPid) await waitForProcessExit(record.waitForPid);
    const child = spawnProcess(record.command, record.args, {
      cwd: record.cwd,
      env: options.childEnvironment?.(record) ?? record.environment,
      stdio: "inherit",
    });
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, childSignal) =>
        resolve({ code, signal: childSignal }),
      );
    });
    exitCode = result.code;
    signal = result.signal;
    if (signal || exitCode !== 0)
      throw new Error(
        `rin_independent_job_child_failed:${exitCode ?? "signal"}`,
      );
    record.status = {
      ...record.status,
      state: "succeeded",
      finishedAt: now(),
      exitCode,
      signal,
    };
    writeRecord(jobPath, record);
    return record;
  } catch (error) {
    record.status = {
      ...record.status,
      state: "failed",
      finishedAt: now(),
      exitCode,
      signal,
      error: error instanceof Error ? error.message : String(error),
    };
    writeRecord(jobPath, record);
    throw error;
  } finally {
    cleanup(record);
  }
}
