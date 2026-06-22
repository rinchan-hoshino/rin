import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { defaultHomeForUser } from "./paths.js";

type SystemUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

export function normalizeUserName(value: unknown) {
  return String(value || "").trim();
}

function normalizeComparableUserName(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  const normalized = normalizeUserName(value);
  if (platform !== "win32") return normalized;
  return normalized.replace(/\//g, "\\").toLowerCase();
}

function windowsAccountParts(value: string) {
  const parts = value.split("\\").filter(Boolean);
  return {
    domain: parts.length > 1 ? parts.slice(0, -1).join("\\") : "",
    name: parts[parts.length - 1] || value,
  };
}

export function isSameSystemUser(
  a: unknown,
  b: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  const left = normalizeComparableUserName(a, platform);
  const right = normalizeComparableUserName(b, platform);
  if (!left || !right) return false;
  if (left === right) return true;
  if (platform !== "win32") return false;
  const leftParts = windowsAccountParts(left);
  const rightParts = windowsAccountParts(right);
  return (
    leftParts.name === rightParts.name &&
    (!leftParts.domain || !rightParts.domain)
  );
}

function isLoginShell(shell: string) {
  return !/nologin|false/.test(shell);
}

function compareSystemUsers(a: SystemUser, b: SystemUser) {
  return a.uid - b.uid || a.name.localeCompare(b.name);
}

function normalizeSystemUser(
  input: Partial<SystemUser>,
): SystemUser | undefined {
  const name = normalizeUserName(input.name);
  const uid = Number(input.uid ?? -1);
  const gid = Number(input.gid ?? -1);
  if (!name || !Number.isFinite(uid) || !Number.isFinite(gid)) return undefined;
  return {
    name,
    uid,
    gid,
    home: String(input.home || "").trim() || defaultHomeForUser(name),
    shell: String(input.shell || "").trim(),
  };
}

function pushSystemUser(
  users: SystemUser[],
  input: Partial<SystemUser>,
  minUid: number,
) {
  const normalized = normalizeSystemUser(input);
  if (!normalized) return;
  if (normalized.uid < minUid || normalized.name === "nobody") return;
  if (!isLoginShell(normalized.shell)) return;
  users.push(normalized);
}

function readDarwinUserAttribute(name: string, attribute: string) {
  try {
    const raw = execFileSync(
      "dscl",
      [".", "-read", `/Users/${name}`, attribute],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const prefix = `${attribute}:`;
    const line = raw
      .split(/\r?\n/)
      .find((item) => item.trimStart().startsWith(prefix));
    return line?.replace(new RegExp(`^\\s*${attribute}:\\s*`), "").trim() || "";
  } catch {
    return "";
  }
}

export function listSystemUsers() {
  const users: SystemUser[] = [];
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync("dscl", [".", "-list", "/Users", "UniqueID"], {
        encoding: "utf8",
      });
      for (const line of raw.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+(\d+)$/);
        if (!match) continue;
        const [, name, uidRaw] = match;
        const uid = Number(uidRaw || 0);
        if (!name || !Number.isFinite(uid)) continue;
        const home = readDarwinUserAttribute(name, "NFSHomeDirectory");
        const shell = readDarwinUserAttribute(name, "UserShell");
        const gid = Number(
          readDarwinUserAttribute(name, "PrimaryGroupID") || 20,
        );
        pushSystemUser(users, { name, uid, gid, home, shell }, 500);
      }
    } catch {}
    return users.sort(compareSystemUsers);
  }

  try {
    const raw = fs.readFileSync("/etc/passwd", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [name = "", , uidRaw = "", gidRaw = "", , home = "", shell = ""] =
        line.split(":");
      const uid = Number(uidRaw || 0);
      const gid = Number(gidRaw || 0);
      pushSystemUser(users, { name, uid, gid, home, shell }, 1000);
    }
  } catch {}
  return users.sort(compareSystemUsers);
}

export function findSystemUser(targetUser: string) {
  const nextTargetUser = normalizeUserName(targetUser);
  if (!nextTargetUser) return undefined;
  return listSystemUsers().find((entry) => entry.name === nextTargetUser);
}

export function homeForUser(targetUser: string) {
  const nextTargetUser = normalizeUserName(targetUser);
  const matched = nextTargetUser ? findSystemUser(nextTargetUser) : undefined;
  return matched?.home || defaultHomeForUser(nextTargetUser);
}

export function targetHomeForUser(targetUser: string) {
  return homeForUser(targetUser);
}

export function describeOwnership(targetUser: string, installDir: string) {
  const target = findSystemUser(targetUser) as any;
  const targetUid = Number(target?.uid ?? -1);
  const targetGid = Number(target?.gid ?? -1);
  try {
    const stat = fs.statSync(installDir);
    let writable = true;
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      ownerMatches: targetUid >= 0 ? stat.uid === targetUid : true,
      writable,
      statUid: stat.uid,
      statGid: stat.gid,
      targetUid,
      targetGid,
    };
  } catch {
    return {
      ownerMatches: true,
      writable: true,
      statUid: -1,
      statGid: -1,
      targetUid,
      targetGid,
    };
  }
}

export function shouldUseElevatedWrite(
  targetUser: string,
  ownership: ReturnType<typeof describeOwnership>,
  currentUser = os.userInfo().username,
  platform: NodeJS.Platform = process.platform,
) {
  return (
    !isSameSystemUser(targetUser, currentUser, platform) ||
    !ownership.ownerMatches ||
    !ownership.writable
  );
}
