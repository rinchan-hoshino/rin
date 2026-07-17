import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { managedSystemdUnitName } from "../rin-install/paths.js";

export type UpdateJobRecord = {
  version: 1;
  id: string;
  unit?: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  command: string;
  args: string[];
  cwd: string;
};

function safeUnitFragment(value: string) {
  return (
    String(value || "")
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

function defaultCgroupText() {
  try {
    return fs.readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    return "";
  }
}

export function isProcessInTargetDaemonCgroup(
  targetUser: string,
  options: { platform?: NodeJS.Platform; cgroupText?: string } = {},
) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return false;
  const text =
    options.cgroupText === undefined ? defaultCgroupText() : options.cgroupText;
  const unit = managedSystemdUnitName(targetUser);
  return String(text || "")
    .split(/\r?\n/)
    .some((line) => {
      const cgroupPath = line.slice(line.lastIndexOf(":") + 1);
      return (
        cgroupPath.includes(`/${unit}/`) || cgroupPath.endsWith(`/${unit}`)
      );
    });
}

function writeJobRecord(jobPath: string, record: UpdateJobRecord) {
  fs.mkdirSync(path.dirname(jobPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${jobPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, jobPath);
  fs.chmodSync(jobPath, 0o600);
}

function forwardedSystemdEnvironment(env: NodeJS.ProcessEnv) {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ];
  return names.flatMap((name) => {
    const value = env[name];
    if (!value || /[\r\n\0]/.test(value)) return [];
    return [`--setenv=${name}=${value}`];
  });
}

export function launchDaemonIndependentUpdateJob(
  options: {
    targetUser: string;
    installDir: string;
    nodePath: string;
    updateEntryPath: string;
    executorEntryPath: string;
    updateArgs: string[];
    cwd: string;
  },
  deps: {
    platform?: NodeJS.Platform;
    cgroupText?: string;
    now?: () => Date;
    randomId?: () => string;
    systemdRunPath?: string;
    execFileSync?: typeof execFileSync;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  if (
    !isProcessInTargetDaemonCgroup(options.targetUser, {
      platform: deps.platform,
      cgroupText: deps.cgroupText,
    })
  ) {
    return null;
  }

  const now = deps.now || (() => new Date());
  const randomId =
    deps.randomId || (() => randomBytes(4).toString("hex").toLowerCase());
  const createdAt = now();
  const timestamp = createdAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();
  const id = `rin-update-${safeUnitFragment(options.targetUser)}-${timestamp}-${safeUnitFragment(randomId())}`;
  const unit = `${id}.service`;
  const jobPath = path.join(
    options.installDir,
    "data",
    "core",
    "updates",
    "jobs",
    `${id}.json`,
  );
  const record: UpdateJobRecord = {
    version: 1,
    id,
    unit,
    status: "queued",
    createdAt: createdAt.toISOString(),
    command: options.nodePath,
    args: [options.updateEntryPath, ...options.updateArgs],
    cwd: options.cwd,
  };
  writeJobRecord(jobPath, record);

  const run = deps.execFileSync || execFileSync;
  const systemdRunPath =
    deps.systemdRunPath ||
    ["/usr/bin/systemd-run", "/bin/systemd-run"].find((candidate) =>
      fs.existsSync(candidate),
    ) ||
    "systemd-run";
  const env = deps.env || process.env;
  try {
    run(
      systemdRunPath,
      [
        "--user",
        `--unit=${id}`,
        "--collect",
        "--property=Type=exec",
        `--description=Rin update job ${id}`,
        ...forwardedSystemdEnvironment(env),
        options.nodePath,
        options.executorEntryPath,
        jobPath,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
  } catch (error) {
    try {
      fs.rmSync(jobPath, { force: true });
    } catch {}
    throw error;
  }
  return { detached: true as const, id, unit, jobPath };
}

function readUpdateJob(jobPath: string): UpdateJobRecord {
  const record = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  if (
    record?.version !== 1 ||
    typeof record?.id !== "string" ||
    typeof record?.command !== "string" ||
    !path.isAbsolute(record.command) ||
    !Array.isArray(record?.args) ||
    !record.args.every((value: unknown) => typeof value === "string") ||
    typeof record?.cwd !== "string" ||
    !path.isAbsolute(record.cwd)
  ) {
    throw new Error("rin_update_job_invalid");
  }
  return record as UpdateJobRecord;
}

export async function runUpdateJobExecutor(
  jobPath: string,
  deps: {
    now?: () => Date;
    spawnImpl?: typeof spawn;
  } = {},
) {
  const now = deps.now || (() => new Date());
  const spawnImpl = deps.spawnImpl || spawn;
  const record = readUpdateJob(jobPath);
  const child = spawnImpl(record.command, record.args, {
    cwd: record.cwd,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  record.status = "running";
  record.startedAt = now().toISOString();
  if (typeof child.pid === "number") record.pid = child.pid;
  writeJobRecord(jobPath, record);

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).catch((error) => {
    record.status = "failed";
    record.finishedAt = now().toISOString();
    record.exitCode = null;
    writeJobRecord(jobPath, record);
    throw error;
  });

  const exitCode = result.code ?? 1;
  record.status = exitCode === 0 && !result.signal ? "succeeded" : "failed";
  record.finishedAt = now().toISOString();
  record.exitCode = result.code;
  record.signal = result.signal;
  writeJobRecord(jobPath, record);
  return exitCode;
}
