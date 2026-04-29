import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getChangelogPath, parseChangelog } from "./changelog.js";
import {
  loadReleaseManifestForNetwork,
  ReleaseChannel,
  ReleaseManifest,
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
  manifest?: ReleaseManifest;
  sourceRoot?: string;
};

const RIN_RELEASE_CHANNELS: readonly ReleaseChannel[] = [
  "stable",
  "beta",
  "nightly",
  "git",
];

function safeString(value: unknown) {
  if (value == null) return "";
  return String(value);
}

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

export function getCurrentRinVersion(sourceRoot?: string) {
  const envVersion = trim(process.env.RIN_RELEASE_VERSION);
  if (parsePackageVersion(envVersion)) return envVersion;
  return readRinPackageVersion(sourceRoot);
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RIN_RELEASE_CHANNELS as readonly string[]).includes(value);
}

export function inferRinReleaseChannel(
  version = getCurrentRinVersion(),
): ReleaseChannel {
  const envChannel = trim(process.env.RIN_RELEASE_CHANNEL).toLowerCase();
  if (isReleaseChannel(envChannel)) {
    return envChannel;
  }
  const normalizedVersion = trim(version).toLowerCase();
  if (normalizedVersion.includes("-nightly.")) return "nightly";
  if (normalizedVersion.includes("-beta.")) return "beta";
  return "stable";
}

export async function latestRinVersionForChannel(
  options: RinUpdateCheckOptions = {},
) {
  const currentVersion = trim(options.currentVersion || getCurrentRinVersion());
  const channel = options.channel || inferRinReleaseChannel(currentVersion);
  if (channel === "git") return undefined;
  const manifest =
    options.manifest ||
    (await loadReleaseManifestForNetwork(options.sourceRoot));
  return resolveReleaseRequest(manifest, { channel }).version;
}

export async function checkForNewRinVersion(
  options: RinUpdateCheckOptions = {},
) {
  if (process.env.PI_OFFLINE || process.env.RIN_OFFLINE) return undefined;
  const currentVersion = trim(options.currentVersion || getCurrentRinVersion());
  if (!parsePackageVersion(currentVersion)) return undefined;
  const latestVersion = await latestRinVersionForChannel({
    ...options,
    currentVersion,
  });
  if (!parsePackageVersion(latestVersion)) return undefined;
  return comparePackageVersions(latestVersion, currentVersion) > 0
    ? latestVersion
    : undefined;
}

export function getRinChangelogUrl() {
  return "https://github.com/rinchanai/rin/blob/main/docs/rin/CHANGELOG.md";
}

export function readRinChangelogEntries() {
  return parseChangelog(getChangelogPath());
}
