import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { managedSystemdUnitName } from "../rin-install/paths.js";
import { updateJobProcessEnvironment } from "../rin-install/update-job-auth.js";
import { RIN_DAEMON_WORKER_OWNER_ENV } from "../rin-lib/profile.js";

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
  cleanup?: {
    command: string;
    args: string[];
    removePaths?: string[];
  };
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

export function isDaemonOwnedUpdate(
  targetUser: string,
  options: {
    platform?: NodeJS.Platform;
    cgroupText?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  if (
    isProcessInTargetDaemonCgroup(targetUser, {
      platform: options.platform,
      cgroupText: options.cgroupText,
    })
  ) {
    return true;
  }
  const owner = String(
    (options.env || process.env)[RIN_DAEMON_WORKER_OWNER_ENV] || "",
  ).trim();
  return Boolean(owner && owner === String(targetUser || "").trim());
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

function forwardedUpdateEnvironment(env: NodeJS.ProcessEnv) {
  const names = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "RIN_DIR",
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
    return [[name, value] as const];
  });
}

function forwardedSystemdEnvironment(env: NodeJS.ProcessEnv) {
  return forwardedUpdateEnvironment(env).map(
    ([name, value]) => `--setenv=${name}=${value}`,
  );
}

function escapeXml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildUpdateLaunchAgent(options: {
  id: string;
  nodePath: string;
  executorEntryPath: string;
  jobPath: string;
  cwd: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}) {
  const args = [options.nodePath, options.executorEntryPath, options.jobPath]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");
  const environment = forwardedUpdateEnvironment(options.env)
    .map(
      ([name, value]) =>
        `      <key>${escapeXml(name)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${escapeXml(options.id)}</string>\n    <key>ProgramArguments</key>\n    <array>\n${args}\n    </array>\n    <key>EnvironmentVariables</key>\n    <dict>\n${environment}\n    </dict>\n    <key>WorkingDirectory</key>\n    <string>${escapeXml(options.cwd)}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>StandardOutPath</key>\n    <string>${escapeXml(options.logPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${escapeXml(options.logPath)}</string>\n  </dict>\n</plist>\n`;
}

function cleanupLaunchFailure(paths: string[]) {
  for (const filePath of paths) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

export function launchIndependentUpdateJob(
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
    launchctlPath?: string;
    uid?: number;
    execFileSync?: typeof execFileSync;
    spawnImpl?: typeof spawn;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const detached = isDaemonOwnedUpdate(options.targetUser, {
    platform,
    cgroupText: deps.cgroupText,
    env,
  });
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
  const jobDir = path.join(
    options.installDir,
    "data",
    "core",
    "updates",
    "jobs",
  );
  const jobPath = path.join(jobDir, `${id}.json`);
  const logPath = path.join(jobDir, `${id}.log`);
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

  if (!detached) {
    writeJobRecord(jobPath, record);
    return {
      detached: false as const,
      launcher: "foreground" as const,
      id,
      unit,
      jobPath,
      logHint: jobPath,
    };
  }

  const run = deps.execFileSync || execFileSync;
  if (platform === "darwin") {
    record.unit = id;
    const launchctlPath = deps.launchctlPath || "/bin/launchctl";
    const uid = deps.uid ?? process.getuid?.();
    if (!Number.isInteger(uid) || Number(uid) < 0) {
      throw new Error("rin_update_launchd_user_domain_missing");
    }
    const domain = `gui/${uid}`;
    const plistPath = path.join(jobDir, `${id}.plist`);
    record.cleanup = {
      command: launchctlPath,
      args: ["bootout", `${domain}/${id}`],
      removePaths: [plistPath],
    };
    try {
      writeJobRecord(jobPath, record);
      fs.writeFileSync(
        plistPath,
        buildUpdateLaunchAgent({
          id,
          nodePath: options.nodePath,
          executorEntryPath: options.executorEntryPath,
          jobPath,
          cwd: options.cwd,
          logPath,
          env,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      run(launchctlPath, ["bootstrap", domain, plistPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      cleanupLaunchFailure([jobPath, plistPath, logPath]);
      throw error;
    }
    return {
      detached: true as const,
      launcher: "launchd" as const,
      id,
      unit: id,
      jobPath,
      logHint: logPath,
    };
  }

  if (platform === "win32") record.unit = id;
  if (platform === "win32") {
    try {
      writeJobRecord(jobPath, record);
      run(options.nodePath, [options.executorEntryPath, "--detach", jobPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      cleanupLaunchFailure([jobPath, logPath]);
      throw error;
    }
    return {
      detached: true as const,
      launcher: "windows-detached" as const,
      id,
      unit: id,
      jobPath,
      logHint: logPath,
    };
  }

  writeJobRecord(jobPath, record);
  const systemdRunPath =
    deps.systemdRunPath ||
    ["/usr/bin/systemd-run", "/bin/systemd-run"].find((candidate) =>
      fs.existsSync(candidate),
    ) ||
    "systemd-run";
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
    cleanupLaunchFailure([jobPath]);
    throw error;
  }
  return {
    detached: true as const,
    launcher: "systemd" as const,
    id,
    unit,
    jobPath,
    logHint: `journalctl --user -u ${unit}`,
  };
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

export async function launchWindowsDetachedUpdateJob(
  executorEntryPath: string,
  jobPath: string,
  deps: { spawnImpl?: typeof spawn } = {},
) {
  const record = readUpdateJob(jobPath);
  const logPath = path.join(path.dirname(jobPath), `${record.id}.log`);
  const logFd = fs.openSync(logPath, "a", 0o600);
  try {
    const child = (deps.spawnImpl || spawn)(
      record.command,
      [executorEntryPath, jobPath],
      {
        cwd: record.cwd,
        detached: true,
        env: process.env,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}

function cleanupCompletedJob(
  record: UpdateJobRecord,
  run: typeof execFileSync = execFileSync,
) {
  const cleanup = record.cleanup;
  if (!cleanup) return;
  for (const filePath of cleanup.removePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
  try {
    run(cleanup.command, cleanup.args, { stdio: "ignore" });
  } catch {}
}

export async function runUpdateJobExecutor(
  jobPath: string,
  deps: {
    now?: () => Date;
    spawnImpl?: typeof spawn;
    execFileSync?: typeof execFileSync;
  } = {},
) {
  const now = deps.now || (() => new Date());
  const spawnImpl = deps.spawnImpl || spawn;
  const record = readUpdateJob(jobPath);
  record.status = "running";
  record.startedAt = now().toISOString();
  writeJobRecord(jobPath, record);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawnImpl(record.command, record.args, {
      cwd: record.cwd,
      env: updateJobProcessEnvironment(jobPath, record.id),
      stdio: "inherit",
    });
  } catch (error) {
    record.status = "failed";
    record.finishedAt = now().toISOString();
    record.exitCode = null;
    writeJobRecord(jobPath, record);
    cleanupCompletedJob(record, deps.execFileSync);
    throw error;
  }
  if (typeof child.pid === "number") {
    record.pid = child.pid;
    writeJobRecord(jobPath, record);
  }

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
    cleanupCompletedJob(record, deps.execFileSync);
    throw error;
  });

  const exitCode = result.code ?? 1;
  record.status = exitCode === 0 && !result.signal ? "succeeded" : "failed";
  record.finishedAt = now().toISOString();
  record.exitCode = result.code;
  record.signal = result.signal;
  writeJobRecord(jobPath, record);
  cleanupCompletedJob(record, deps.execFileSync);
  return exitCode;
}
