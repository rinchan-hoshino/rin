import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeString } from "../text-utils.js";
import { getChangelogPath, parseChangelog } from "./changelog.js";
import { resolveRuntimeProfile } from "./profile.js";
import {
  getReleaseRepoUrl,
  type InstalledReleaseInfo,
  loadReleaseManifestForNetwork,
  ReleaseChannel,
  ReleaseManifest,
  releaseInfoFromEnv,
  resolveReleaseRequest,
} from "./release.js";

export type ParsedPackageVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export type RinUpdateCheckOptions = {
  currentVersion?: string;
  channel?: ReleaseChannel;
  currentRelease?: InstalledReleaseInfo;
  manifest?: ReleaseManifest;
  runtimeDir?: string;
  sourceRoot?: string;
};

export type RinUpdateNotice = {
  version: string;
  channel: ReleaseChannel;
  currentVersion: string;
  command: string;
};

export type RinChangelogEntry = {
  heading: string;
  content: string;
};

const RIN_RELEASE_CHANNELS: readonly ReleaseChannel[] = [
  "stable",
  "beta",
  "nightly",
  "git",
];

function trim(value: unknown) {
  return safeString(value).trim();
}

function moduleRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

export function parsePackageVersion(
  value: unknown,
): ParsedPackageVersion | undefined {
  const text = trim(value);
  const match = text.match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/,
  );
  if (!match) return undefined;
  return {
    major: Number.parseInt(match[1] || "0", 10),
    minor: Number.parseInt(match[2] || "0", 10),
    patch: Number.parseInt(match[3] || "0", 10),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumber = /^\d+$/.test(left) ? Number.parseInt(left, 10) : NaN;
    const rightNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : NaN;
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
      continue;
    }
    if (Number.isFinite(leftNumber)) return -1;
    if (Number.isFinite(rightNumber)) return 1;
    const compared = left.localeCompare(right);
    if (compared !== 0) return compared;
  }

  return 0;
}

export function comparePackageVersions(a: unknown, b: unknown) {
  const left = parsePackageVersion(a);
  const right = parsePackageVersion(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function readRinPackageVersion(sourceRoot = moduleRootFromHere()) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
    );
    return trim(packageJson.version) || "unknown";
  } catch {
    return "unknown";
  }
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RIN_RELEASE_CHANNELS as readonly string[]).includes(value);
}

function normalizeInstalledReleaseInfo(
  value: unknown,
): InstalledReleaseInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const channelText = trim(record.channel).toLowerCase();
  const channel = isReleaseChannel(channelText) ? channelText : "stable";
  const version = trim(record.version);
  const branch = trim(record.branch);
  const ref = trim(record.ref);
  const sourceLabel = trim(record.sourceLabel);
  const archiveUrl = trim(record.archiveUrl);
  const installedAt = trim(record.installedAt);
  if (!version && !branch && !ref && !sourceLabel && !archiveUrl) {
    return undefined;
  }
  return {
    channel,
    version: version || ref || branch || "unknown",
    branch: branch || (channel === "stable" ? "stable" : "main"),
    ref: ref || branch || version || "main",
    sourceLabel:
      sourceLabel || `${channel} ${version || branch || ref || "unknown"}`,
    archiveUrl,
    ...(installedAt ? { installedAt } : {}),
  };
}

export function readInstalledRinReleaseInfo(
  runtimeDir = resolveRuntimeProfile().agentDir,
): InstalledReleaseInfo | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "installer.json"), "utf8"),
    ) as Record<string, unknown>;
    return (
      normalizeInstalledReleaseInfo(
        (manifest.currentRelease as any)?.release,
      ) || normalizeInstalledReleaseInfo(manifest.release)
    );
  } catch {
    return undefined;
  }
}

function currentReleaseInfoForOptions(
  options: RinUpdateCheckOptions = {},
): InstalledReleaseInfo | undefined {
  return (
    options.currentRelease ||
    releaseInfoFromEnv() ||
    readInstalledRinReleaseInfo(options.runtimeDir)
  );
}

export function readInstalledRinReleaseVersion(
  agentDir = resolveRuntimeProfile().agentDir,
): string | undefined {
  return readInstalledRinReleaseInfo(agentDir)?.version;
}

export function getCurrentRinVersion(
  sourceRoot?: string,
  currentRelease?: InstalledReleaseInfo,
) {
  const envVersion = trim(process.env.RIN_RELEASE_VERSION);
  if (envVersion) return envVersion;
  const releaseVersion = trim(currentRelease?.version);
  if (releaseVersion) return releaseVersion;
  if (!sourceRoot) {
    const installedVersion = readInstalledRinReleaseVersion();
    if (installedVersion) return installedVersion;
  }
  return readRinPackageVersion(sourceRoot);
}

export function inferRinReleaseChannel(
  version = getCurrentRinVersion(),
  currentRelease?: InstalledReleaseInfo,
): ReleaseChannel {
  const envChannel = trim(process.env.RIN_RELEASE_CHANNEL).toLowerCase();
  if (isReleaseChannel(envChannel)) {
    return envChannel;
  }
  const normalizedVersion = trim(version).toLowerCase();
  if (normalizedVersion.includes("-nightly.")) return "nightly";
  if (normalizedVersion.includes("-beta.")) return "beta";
  if (currentRelease?.channel) return currentRelease.channel;
  return "stable";
}

function currentUpdateContext(options: RinUpdateCheckOptions = {}) {
  const currentRelease = currentReleaseInfoForOptions(options);
  const currentVersion = trim(
    options.currentVersion ||
      getCurrentRinVersion(options.sourceRoot, currentRelease),
  );
  const channel =
    options.channel || inferRinReleaseChannel(currentVersion, currentRelease);
  return { currentRelease, currentVersion, channel };
}

export function rinUpdateCommandForChannel(
  channel: ReleaseChannel,
  currentRelease?: InstalledReleaseInfo,
) {
  if (channel === "beta") return "rin update --beta";
  if (channel === "nightly") return "rin update --nightly";
  if (channel === "git") {
    const branch = trim(currentRelease?.branch);
    return branch ? `rin update --git ${branch}` : "rin update --git";
  }
  return "rin update";
}

function isGitHash(value: unknown) {
  return /^[0-9a-f]{7,40}$/i.test(trim(value));
}

function gitRefsMatch(a: unknown, b: unknown) {
  const left = trim(a).toLowerCase();
  const right = trim(b).toLowerCase();
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function shortGitRef(value: unknown) {
  const text = trim(value);
  return isGitHash(text) ? text.slice(0, 12) : text;
}

export function versionFromRinChangelogHeading(heading: unknown) {
  const match = trim(heading).match(
    /^\[?(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?\b/,
  );
  return match?.[1];
}

export function getNewRinChangelogEntries(
  entries: readonly RinChangelogEntry[],
  lastVersion: unknown,
  currentVersion?: unknown,
) {
  if (!parsePackageVersion(lastVersion)) return [];
  const current = parsePackageVersion(currentVersion)
    ? currentVersion
    : undefined;
  return entries.filter((entry) => {
    const entryVersion = versionFromRinChangelogHeading(entry.heading);
    if (!entryVersion) return false;
    if (comparePackageVersions(entryVersion, lastVersion) <= 0) return false;
    return (
      current === undefined ||
      comparePackageVersions(entryVersion, current) <= 0
    );
  });
}

function latestGitRefForBranch(
  manifest: ReleaseManifest,
  currentRelease?: InstalledReleaseInfo,
) {
  if (!manifest.git) return undefined;
  const branch = trim(
    currentRelease?.branch || manifest.git.defaultBranch || "main",
  );
  if (!branch) return undefined;
  const repoUrl = trim(manifest.git?.repoUrl) || getReleaseRepoUrl(manifest);
  try {
    const raw = execFileSync(
      "git",
      ["ls-remote", repoUrl, `refs/heads/${branch}`],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      },
    ).trim();
    const hash = raw.split(/\s+/)[0] || "";
    return isGitHash(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

export async function latestRinVersionForChannel(
  options: RinUpdateCheckOptions = {},
) {
  const { channel, currentRelease } = currentUpdateContext(options);
  const manifest =
    options.manifest ||
    (await loadReleaseManifestForNetwork(options.sourceRoot));
  if (channel === "git") return latestGitRefForBranch(manifest, currentRelease);
  return resolveReleaseRequest(manifest, { channel }).version;
}

export async function checkForRinUpdateNotice(
  options: RinUpdateCheckOptions = {},
): Promise<RinUpdateNotice | undefined> {
  if (process.env.PI_SKIP_VERSION_CHECK) return undefined;
  if (process.env.PI_OFFLINE || process.env.RIN_OFFLINE) return undefined;
  const { currentRelease, currentVersion, channel } =
    currentUpdateContext(options);
  const latestVersion = await latestRinVersionForChannel({
    ...options,
    currentVersion,
    channel,
  });
  if (channel === "git") {
    const currentRef = currentRelease?.ref || currentVersion;
    if (!latestVersion || gitRefsMatch(latestVersion, currentRef)) {
      return undefined;
    }
    return {
      version: shortGitRef(latestVersion),
      channel,
      currentVersion,
      command: rinUpdateCommandForChannel(channel, currentRelease),
    };
  }
  if (!parsePackageVersion(currentVersion)) return undefined;
  if (!parsePackageVersion(latestVersion)) return undefined;
  if (comparePackageVersions(latestVersion, currentVersion) <= 0) {
    return undefined;
  }
  return {
    version: latestVersion,
    channel,
    currentVersion,
    command: rinUpdateCommandForChannel(channel, currentRelease),
  };
}

export async function checkForNewRinVersion(
  options: RinUpdateCheckOptions = {},
) {
  return (await checkForRinUpdateNotice(options))?.version;
}

export function getRinChangelogUrl() {
  return "https://github.com/rinchanai/rin/blob/main/docs/release/CHANGELOG.md";
}

export function readRinChangelogEntries() {
  return parseChangelog(getChangelogPath());
}
