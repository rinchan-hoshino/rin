import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

import {
  captureCommandAsUser,
  ensureDir,
  installedRuntimeNodeCommandArgs,
  installedRuntimeNodePathDirs,
  installedRuntimePathValue,
  runCommandAsUser,
  runPrivileged,
  writeTextFile,
  writeTextFileWithPrivilege,
} from "./fs-utils.js";
import {
  daemonSocketPathForHome,
  daemonStderrLogPath,
  daemonStdoutLogPath,
  installedAppEntryCandidates,
  launchAgentPlistPathForHome,
  managedLaunchdLabel,
  managedSystemdUnitCandidates,
  managedSystemdUnitName,
  managedSystemdUnitPathsForHome,
  resolveInstalledAppEntryPath,
  systemdUserUnitPathForHome,
  windowsStartupLauncherPathForHome,
} from "./paths.js";
import { sleep } from "../platform/process.js";
import {
  buildDaemonSocketProbeScript,
  canConnectDaemonSocket,
} from "../rin-daemon/client.js";
import {
  findManagedSystemdJournalSnapshot,
  findManagedSystemdStatusSnapshot,
  tryManagedSystemdAction,
} from "./managed-service.js";
import { isSameSystemUser } from "./users.js";

function currentSystemUser() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

function isCurrentSystemUser(
  targetUser: string,
  currentUser = currentSystemUser(),
) {
  return !targetUser || isSameSystemUser(targetUser, currentUser);
}

function firstExistingCommand(candidates: string[], fallback: string) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

function systemdQuote(value: string) {
  let escaped = "";
  for (const char of String(value)) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case '"':
        escaped += '\\"';
        break;
      case "\u0007":
        escaped += "\\a";
        break;
      case "\b":
        escaped += "\\b";
        break;
      case "\f":
        escaped += "\\f";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\v":
        escaped += "\\v";
        break;
      default:
        escaped += char;
        break;
    }
  }
  return `"${escaped}"`;
}

function escapeXmlText(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function windowsCmdQuote(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function resolveTargetUserContext(
  targetUser: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser?: (user: string) => string;
  },
) {
  const target = deps.findSystemUser(targetUser) as any;
  const uid = Number(target?.uid ?? -1);
  const targetHome = deps.targetHomeForUser?.(targetUser) || "";
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : "";
  const userEnv =
    runtimeDir && fs.existsSync(runtimeDir)
      ? {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        }
      : {};
  return {
    target,
    uid,
    targetHome,
    runtimeDir,
    userEnv,
  };
}

function resolveDaemonLaunchContext(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
  platform: NodeJS.Platform = process.platform,
) {
  const targetHome = targetHomeForUser(targetUser);
  return {
    targetHome,
    daemonEntry: resolveDaemonEntryForInstall(installDir),
    runtimePath: installedRuntimePathValue(
      targetHome,
      installedRuntimeNodePathDirs({ installDir, platform }),
    ),
    nodeCommandArgs: installedRuntimeNodeCommandArgs({ installDir, platform }),
  };
}

function captureCommandForTargetUser(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  if (!isCurrentSystemUser(targetUser)) {
    return captureCommandAsUser(targetUser, command, args, extraEnv);
  }
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

const MANAGED_SERVICE_FILE_MODE = 0o644;

function writeManagedServiceFile(
  filePath: string,
  value: string,
  options: {
    elevated?: boolean;
    ownerUser?: string;
    ownerGroup?: string | number;
    mode?: number;
  } = {},
) {
  const {
    elevated = false,
    ownerUser,
    ownerGroup,
    mode = MANAGED_SERVICE_FILE_MODE,
  } = options;
  if (elevated) {
    writeTextFileWithPrivilege(filePath, value, ownerUser, ownerGroup, mode);
    return;
  }
  writeTextFile(filePath, value, mode);
}

export function systemctlUserCommandArgs(args: string[]) {
  return ["--user", ...args];
}

export function systemctlMachineUserCommandArgs(
  targetUser: string,
  args: string[],
) {
  return ["--machine", `${targetUser}@.host`, "--user", ...args];
}

export function systemctlCommandArgsForTargetUser(
  targetUser: string,
  args: string[],
  currentUser = currentSystemUser(),
) {
  return !isCurrentSystemUser(targetUser, currentUser)
    ? systemctlMachineUserCommandArgs(targetUser, args)
    : systemctlUserCommandArgs(args);
}

function runSystemdUserCommand(
  targetUser: string,
  context: {
    systemctl: string;
    userEnv: Record<string, string>;
  },
  args: string[],
  elevated = false,
) {
  const useMachine = !isCurrentSystemUser(targetUser);
  const commandArgs = systemctlCommandArgsForTargetUser(targetUser, args);
  if (useMachine) {
    if (elevated) {
      runPrivileged(context.systemctl, commandArgs);
      return;
    }
    execFileSync(context.systemctl, commandArgs, {
      stdio: "inherit",
      env: { ...process.env },
    });
    return;
  }
  if (elevated) {
    runCommandAsUser(
      targetUser,
      context.systemctl,
      commandArgs,
      context.userEnv,
    );
    return;
  }
  execFileSync(context.systemctl, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...context.userEnv },
  });
}

export function resolveDaemonEntryForInstall(installDir: string) {
  const candidates = installedAppEntryCandidates(installDir, "rin-daemon");
  const resolved = resolveInstalledAppEntryPath(
    installDir,
    "rin-daemon",
    fs.existsSync,
  );
  if (resolved) return resolved;
  throw new Error(`rin_installed_daemon_entry_missing:${candidates.join(",")}`);
}

export function buildLaunchdPlist(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const label = managedLaunchdLabel(targetUser);
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(targetUser, installDir, targetHomeForUser);
  const stdoutPath = daemonStdoutLogPath(installDir);
  const stderrPath = daemonStderrLogPath(installDir);
  const plistPath = launchAgentPlistPathForHome(targetHome, label);
  const programArguments = [...nodeCommandArgs, daemonEntry]
    .map((entry) => `      <string>${escapeXmlText(entry)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${escapeXmlText(label)}</string>\n    <key>ProgramArguments</key>\n    <array>\n${programArguments}\n    </array>\n    <key>EnvironmentVariables</key>\n    <dict>\n      <key>PATH</key>\n      <string>${escapeXmlText(runtimePath)}</string>\n      <key>RIN_DIR</key>\n      <string>${escapeXmlText(installDir)}</string>\n    </dict>\n    <key>WorkingDirectory</key>\n    <string>${escapeXmlText(targetHome)}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>StandardOutPath</key>\n    <string>${escapeXmlText(stdoutPath)}</string>\n    <key>StandardErrorPath</key>\n    <string>${escapeXmlText(stderrPath)}</string>\n  </dict>\n</plist>\n`;
  return { label, plistPath, plist, stdoutPath, stderrPath };
}

export type InstallDaemonServiceOptions = {
  activate?: boolean;
};

export function installLaunchdAgent(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
  options: InstallDaemonServiceOptions = {},
) {
  const { target, uid } = resolveTargetUserContext(targetUser, deps);
  if (uid < 0)
    throw new Error(`rin_launchd_target_user_not_found:${targetUser}`);
  const { label, plistPath, plist, stdoutPath, stderrPath } = buildLaunchdPlist(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  if (elevated) {
    runPrivileged("mkdir", ["-p", path.dirname(plistPath)]);
    runPrivileged("mkdir", ["-p", path.dirname(stdoutPath)]);
    writeManagedServiceFile(plistPath, plist, {
      elevated: true,
      ownerUser: targetUser,
      ownerGroup: target?.gid,
    });
    if (options.activate !== false) {
      try {
        runPrivileged("launchctl", ["bootout", `gui/${uid}`, plistPath]);
      } catch {}
      runPrivileged("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    }
  } else {
    ensureDir(path.dirname(plistPath));
    ensureDir(path.dirname(stdoutPath));
    writeManagedServiceFile(plistPath, plist);
    if (options.activate !== false) {
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], {
          stdio: "ignore",
        });
      } catch {}
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
        stdio: "inherit",
      });
    }
  }
  return {
    kind: "launchd" as const,
    label,
    servicePath: plistPath,
    stdoutPath,
    stderrPath,
  };
}

export function buildSystemdUserService(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(targetUser, installDir, targetHomeForUser);
  const unitName = managedSystemdUnitName(targetUser);
  const unitPath = systemdUserUnitPathForHome(targetHome, unitName);
  const execStart = [...nodeCommandArgs, daemonEntry]
    .map((entry) => systemdQuote(entry))
    .join(" ");
  const service = `[Unit]\nDescription=Rin daemon for ${targetUser}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${targetHome}\nEnvironment=${systemdQuote(`PATH=${runtimePath}`)}\nEnvironment=${systemdQuote(`RIN_DIR=${installDir}`)}\nEnvironment=${systemdQuote("RIN_SYSTEMD_CGROUP_DELEGATION=1")}\nExecStart=${execStart}\nDelegate=memory\nDelegateSubgroup=daemon\nOOMPolicy=continue\nKillMode=mixed\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  return {
    kind: "systemd" as const,
    label: unitName,
    servicePath: unitPath,
    service,
  };
}

export function installSystemdUserService(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
  options: InstallDaemonServiceOptions = {},
) {
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  const { systemctl, userEnv, target } = systemdUserContext(targetUser, deps);
  const loginctl = firstExistingCommand(
    ["/usr/bin/loginctl", "/bin/loginctl"],
    "loginctl",
  );
  writeManagedServiceFile(spec.servicePath, spec.service, {
    elevated,
    ownerUser: targetUser,
    ownerGroup: target?.gid,
  });
  if (elevated) {
    try {
      runPrivileged(loginctl, ["enable-linger", targetUser]);
    } catch {}
  }
  runSystemdUserCommand(
    targetUser,
    { systemctl, userEnv },
    ["daemon-reload"],
    elevated,
  );
  runSystemdUserCommand(
    targetUser,
    { systemctl, userEnv },
    ["enable", ...(options.activate === false ? [] : ["--now"]), spec.label],
    elevated,
  );
  return spec;
}

export function refreshManagedServiceFiles(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  if (process.platform !== "linux") return;
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  const ownerGroup = deps.findSystemUser(targetUser)?.gid;
  for (const filePath of managedSystemdUnitPathsForHome(
    deps.targetHomeForUser(targetUser),
    targetUser,
  )) {
    if (!fs.existsSync(filePath)) continue;
    writeManagedServiceFile(filePath, spec.service, {
      elevated,
      ownerUser: targetUser,
      ownerGroup,
    });
  }
}

export function systemdUserContext(
  targetUser: string,
  deps: { findSystemUser: (user: string) => any },
) {
  const { target, uid, runtimeDir, userEnv } = resolveTargetUserContext(
    targetUser,
    deps,
  );
  return {
    target,
    uid,
    runtimeDir,
    systemctl: firstExistingCommand(
      ["/usr/bin/systemctl", "/bin/systemctl"],
      "",
    ),
    userEnv,
    units: managedSystemdUnitCandidates(targetUser),
  };
}

export function daemonSocketPathForUser(
  targetUser: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const { uid, targetHome } = resolveTargetUserContext(targetUser, deps);
  return daemonSocketPathForHome(targetHome, { uid });
}

export function collectDaemonFailureDetails(
  targetUser: string,
  installDir: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const socketPath = daemonSocketPathForUser(targetUser, deps);
  const lines = [
    `targetUser=${targetUser}`,
    `installDir=${installDir}`,
    `socketPath=${socketPath}`,
    "socketReady=no",
  ];
  if (process.platform === "linux") {
    const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps);
    if (systemctl) {
      const status = findManagedSystemdStatusSnapshot(units, (unit) =>
        captureCommandForTargetUser(
          targetUser,
          systemctl,
          ["--user", "status", unit, "--no-pager", "-l"],
          userEnv,
        ),
      );
      if (status) {
        lines.push(
          `serviceUnit=${status.unit}`,
          "serviceStatus:",
          ...status.lines,
        );
      }
      const journal = findManagedSystemdJournalSnapshot(units, (unit) =>
        captureCommandForTargetUser(
          targetUser,
          "journalctl",
          ["--user", "-u", unit, "-n", "20", "--no-pager"],
          userEnv,
        ),
      );
      if (journal) {
        lines.push(`serviceJournal=${journal.unit}`, ...journal.lines);
      }
    }
  }
  return lines.join("\n");
}

export function reconcileSystemdUserService(
  targetUser: string,
  installDir: string,
  action: "start" | "stop" | "restart",
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  void installDir;
  if (process.platform !== "linux") return false;
  const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps);
  if (!systemctl) return false;
  return Boolean(
    tryManagedSystemdAction(units, {
      daemonReload: () =>
        runSystemdUserCommand(
          targetUser,
          { systemctl, userEnv },
          ["daemon-reload"],
          elevated,
        ),
      runAction: (unit) =>
        runSystemdUserCommand(
          targetUser,
          { systemctl, userEnv },
          [action, unit],
          elevated,
        ),
    }),
  );
}

export function buildWindowsStartupCommand(options: {
  nodePath: string;
  daemonEntry: string;
  installDir: string;
}) {
  return `@echo off
set "RIN_DIR=${String(options.installDir).replace(/"/g, '""')}"
start "" /min ${windowsCmdQuote(options.nodePath)} ${windowsCmdQuote(options.daemonEntry)}
`;
}

export function buildWindowsStartupLauncher(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const context = resolveDaemonLaunchContext(
    targetUser,
    installDir,
    targetHomeForUser,
    "win32",
  );
  const launcherPath = windowsStartupLauncherPathForHome(context.targetHome);
  return {
    kind: "windows-startup" as const,
    label: "Rin Daemon",
    servicePath: launcherPath,
    stdoutPath: daemonStdoutLogPath(installDir),
    stderrPath: daemonStderrLogPath(installDir),
    service: buildWindowsStartupCommand({
      nodePath: context.nodeCommandArgs[0] || "",
      daemonEntry: context.daemonEntry,
      installDir,
    }),
  };
}

export function buildWindowsDaemonLaunchSpec(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const context = resolveDaemonLaunchContext(
    targetUser,
    installDir,
    targetHomeForUser,
    "win32",
  );
  return {
    command: context.nodeCommandArgs[0] || "",
    args: [context.daemonEntry],
    cwd: context.targetHome,
    env: { RIN_DIR: installDir },
    stdoutPath: daemonStdoutLogPath(installDir),
    stderrPath: daemonStderrLogPath(installDir),
  };
}

export function startWindowsDaemonProcess(
  targetUser: string,
  installDir: string,
  deps: {
    targetHomeForUser: (user: string) => string;
  },
) {
  if (process.platform !== "win32") return false;
  const currentUser = currentSystemUser();
  if (!isCurrentSystemUser(targetUser, currentUser)) {
    throw new Error(`rin_windows_daemon_cross_user_unsupported:${targetUser}`);
  }
  const spec = buildWindowsDaemonLaunchSpec(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  ensureDir(path.dirname(spec.stdoutPath));
  const stdout = fs.openSync(spec.stdoutPath, "a");
  const stderr = fs.openSync(spec.stderrPath, "a");
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
    child.unref();
    return true;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
}

export function installWindowsStartupLauncher(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    targetHomeForUser: (user: string) => string;
  },
  options: InstallDaemonServiceOptions = {},
) {
  const spec = buildWindowsStartupLauncher(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  writeManagedServiceFile(spec.servicePath, spec.service, { elevated });
  if (options.activate !== false) {
    startWindowsDaemonProcess(targetUser, installDir, deps);
  }
  return spec;
}

export function installDaemonService(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
  options: InstallDaemonServiceOptions = {},
) {
  if (process.platform === "darwin")
    return installLaunchdAgent(targetUser, installDir, elevated, deps, options);
  if (
    process.platform === "linux" &&
    (fs.existsSync("/usr/bin/systemctl") || fs.existsSync("/bin/systemctl"))
  )
    return installSystemdUserService(
      targetUser,
      installDir,
      elevated,
      deps,
      options,
    );
  if (process.platform === "win32")
    return installWindowsStartupLauncher(
      targetUser,
      installDir,
      elevated,
      deps,
      options,
    );
  throw new Error(`rin_service_install_unsupported:${process.platform}`);
}

export async function waitForSocket(
  socketPath: string,
  timeoutMs = 5000,
  targetUser?: string,
  options: {
    currentUser?: string;
    targetNodePath?: string;
    captureCommandAsUser?: typeof captureCommandAsUser;
    canConnectDaemonSocket?: typeof canConnectDaemonSocket;
  } = {},
) {
  const startedAt = Date.now();
  const currentUser = options.currentUser || currentSystemUser();
  const isCurrentUser = isCurrentSystemUser(targetUser, currentUser);
  const captureAsUser = options.captureCommandAsUser ?? captureCommandAsUser;
  const connectSocket =
    options.canConnectDaemonSocket ?? canConnectDaemonSocket;
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      if (!isCurrentUser) {
        const targetNodePath = String(options.targetNodePath || "").trim();
        if (!targetNodePath) {
          resolve(false);
          return;
        }
        try {
          const probe = captureAsUser(targetUser || "", targetNodePath, [
            "-e",
            buildDaemonSocketProbeScript(socketPath, 300),
          ]);
          void probe;
          resolve(true);
          return;
        } catch {
          resolve(false);
          return;
        }
      }
      void connectSocket(socketPath, 300).then(resolve);
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}
