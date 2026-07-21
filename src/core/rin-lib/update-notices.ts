import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  createRinHttpTransport,
  discardRinHttpResponseBody,
  type RinHttpFetch,
} from "../http/transport.js";
import { safeString } from "../text-utils.js";
import { getChangelogPath, parseChangelog } from "./changelog.js";
import { resolveRuntimeProfile } from "./profile.js";
import type {
  InstalledReleaseInfo,
  ReleaseChannel,
  ReleaseManifest,
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

export type InstalledRinReleaseState = {
  currentRelease?: InstalledReleaseInfo;
  previousRelease?: InstalledReleaseInfo;
};

export type RinGitChangelogRange = {
  currentRef: string;
  baseRef?: string;
};

export type RinGitCommit = {
  sha: string;
  subject: string;
  url?: string;
};

export type RinGitChangelogNotice = {
  baseRef: string;
  currentRef: string;
  totalCommits: number;
  commits: RinGitCommit[];
  compareUrl: string;
};

export type RinGitChangelogProcessOptions = {
  lastVersion?: unknown;
  currentRelease?: InstalledReleaseInfo;
  previousRelease?: InstalledReleaseInfo;
  runtimeDir?: string;
  repoUrl?: string;
  fetch?: RinHttpFetch;
  showNotice: (notice: RinGitChangelogNotice) => Promise<boolean> | boolean;
  setLastVersion: (version: string) => Promise<void> | void;
};

const RIN_RELEASE_CHANNELS: readonly ReleaseChannel[] = [
  "stable",
  "beta",
  "nightly",
  "git",
];
const execFileAsync = promisify(execFile);

function trim(value: unknown) {
  return safeString(value).trim();
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
  if (channel === "git") {
    const concreteRef = isGitHash(ref)
      ? ref
      : isGitHash(version)
        ? version
        : "";
    const concreteVersion = isGitHash(version)
      ? version
      : concreteRef
        ? concreteRef.slice(0, 12)
        : "unknown";
    return {
      channel,
      version: concreteVersion,
      branch: branch || "main",
      ref: concreteRef,
      sourceLabel: sourceLabel || `git ${branch || "main"}`,
      archiveUrl,
      ...(installedAt ? { installedAt } : {}),
    };
  }
  return {
    channel,
    version: version || "unknown",
    branch: branch || (channel === "stable" ? "stable" : "main"),
    ref: ref || version || "main",
    sourceLabel: sourceLabel || `${channel} ${version || ref || "unknown"}`,
    archiveUrl,
    ...(installedAt ? { installedAt } : {}),
  };
}

export function readInstalledRinReleaseState(
  runtimeDir = resolveRuntimeProfile().agentDir,
): InstalledRinReleaseState {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "installer.json"), "utf8"),
    ) as Record<string, unknown>;
    return {
      currentRelease: normalizeInstalledReleaseInfo(
        (manifest.currentRelease as any)?.release,
      ),
      previousRelease: normalizeInstalledReleaseInfo(
        (manifest.previousRelease as any)?.release,
      ),
    };
  } catch {
    return {};
  }
}

export function readInstalledRinReleaseInfo(
  runtimeDir = resolveRuntimeProfile().agentDir,
): InstalledReleaseInfo | undefined {
  return readInstalledRinReleaseState(runtimeDir).currentRelease;
}

function currentReleaseInfoForOptions(
  options: RinUpdateCheckOptions = {},
): InstalledReleaseInfo | undefined {
  return (
    options.currentRelease || readInstalledRinReleaseInfo(options.runtimeDir)
  );
}

export function readInstalledRinReleaseVersion(
  agentDir = resolveRuntimeProfile().agentDir,
): string | undefined {
  return readInstalledRinReleaseInfo(agentDir)?.version;
}

export function getCurrentRinVersion(
  _sourceRoot?: string,
  currentRelease?: InstalledReleaseInfo,
) {
  const releaseVersion = trim(currentRelease?.version);
  if (releaseVersion) return releaseVersion;
  return readInstalledRinReleaseVersion() || "unknown";
}

export function inferRinReleaseChannel(
  version = getCurrentRinVersion(),
  currentRelease?: InstalledReleaseInfo,
): ReleaseChannel {
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
  _channel: ReleaseChannel,
  _currentRelease?: InstalledReleaseInfo,
) {
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

export function getRinStartupChangelogEntries(
  entries: readonly RinChangelogEntry[],
  lastVersion: unknown,
  currentVersion: unknown,
) {
  if (!trim(lastVersion) || !parsePackageVersion(currentVersion)) return [];
  if (
    parsePackageVersion(lastVersion) &&
    comparePackageVersions(currentVersion, lastVersion) > 0
  ) {
    return getNewRinChangelogEntries(entries, lastVersion, currentVersion);
  }
  if (
    parsePackageVersion(lastVersion) &&
    comparePackageVersions(currentVersion, lastVersion) === 0
  ) {
    return [];
  }
  return entries.filter((entry) => {
    const entryVersion = versionFromRinChangelogHeading(entry.heading);
    return (
      entryVersion !== undefined &&
      comparePackageVersions(entryVersion, currentVersion) === 0
    );
  });
}

function concreteReleaseRef(release?: InstalledReleaseInfo) {
  const ref = trim(release?.ref || release?.version);
  return isGitHash(ref) ? ref : "";
}

function currentGitRef(currentRelease?: InstalledReleaseInfo) {
  return currentRelease?.channel === "git"
    ? concreteReleaseRef(currentRelease)
    : "";
}

export function resolveRinGitChangelogRange(options: {
  lastVersion?: unknown;
  currentRelease?: InstalledReleaseInfo;
  previousRelease?: InstalledReleaseInfo;
}): RinGitChangelogRange | undefined {
  const currentRef = currentGitRef(options.currentRelease);
  if (!currentRef) return undefined;
  const lastVersion = trim(options.lastVersion);
  if (!lastVersion) return { currentRef };
  if (gitRefsMatch(lastVersion, currentRef)) return undefined;

  const previousRef = concreteReleaseRef(options.previousRelease);
  const baseRef = isGitHash(lastVersion)
    ? lastVersion
    : previousRef && !gitRefsMatch(previousRef, currentRef)
      ? previousRef
      : "";
  return baseRef ? { baseRef, currentRef } : { currentRef };
}

function githubRepoPath(repoUrl: unknown) {
  const normalized = trim(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalized);
  if (sshMatch?.[1] && sshMatch[2]) {
    return [sshMatch[1], sshMatch[2]].map(encodeURIComponent).join("/");
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return "";
    return [owner, repo].map(encodeURIComponent).join("/");
  } catch {
    return "";
  }
}

function commitSubject(value: unknown) {
  return trim(value).split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") || "";
}

export async function fetchRinGitChangelogNotice(options: {
  baseRef: string;
  currentRef: string;
  repoUrl?: string;
  fetch?: RinHttpFetch;
}): Promise<RinGitChangelogNotice> {
  const { getReleaseRepoUrl, readBundledReleaseManifest } =
    await import("./release.js");
  const repoUrl = trim(
    options.repoUrl || getReleaseRepoUrl(readBundledReleaseManifest()),
  );
  const repoPath = githubRepoPath(repoUrl);
  if (!repoPath)
    throw new Error("Rin git changelog requires a GitHub repo URL");

  const baseRef = trim(options.baseRef);
  const currentRef = trim(options.currentRef);
  if (!isGitHash(baseRef) || !isGitHash(currentRef)) {
    throw new Error("Rin git changelog requires concrete commit refs");
  }

  const apiUrl = `https://api.github.com/repos/${repoPath}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(currentRef)}`;
  const compareUrl = `https://github.com/${repoPath}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(currentRef)}`;
  const transport = options.fetch ? undefined : createRinHttpTransport();
  const fetch = options.fetch || transport?.fetch;
  if (!fetch) throw new Error("Rin git changelog HTTP transport unavailable");

  let response: any;
  try {
    response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Rin-TUI",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response?.ok) {
      throw new Error(
        `Rin git changelog compare failed with HTTP ${response?.status || "unknown"}`,
      );
    }
    const payload = (await response.json()) as Record<string, any>;
    if (!Array.isArray(payload.commits)) {
      throw new Error("Rin git changelog compare returned malformed commits");
    }
    const rawCommits = payload.commits;
    const parsedCommits = rawCommits.flatMap((entry: any) => {
      const sha = trim(entry?.sha);
      const subject = commitSubject(entry?.commit?.message);
      if (!isGitHash(sha) || !subject) return [];
      const url = trim(entry?.html_url);
      return [
        {
          sha: sha.slice(0, 7),
          subject,
          ...(url ? { url } : {}),
        },
      ];
    });
    const totalCommits = payload.total_commits;
    if (
      parsedCommits.length !== rawCommits.length ||
      typeof totalCommits !== "number" ||
      !Number.isSafeInteger(totalCommits) ||
      totalCommits < rawCommits.length
    ) {
      throw new Error("Rin git changelog compare returned malformed commits");
    }
    const commits = parsedCommits.slice(0, 20);
    return {
      baseRef,
      currentRef,
      totalCommits,
      commits,
      compareUrl: trim(payload.html_url) || compareUrl,
    };
  } finally {
    await discardRinHttpResponseBody(response);
    await transport?.close();
  }
}

export async function processRinGitStartupChangelog(
  options: RinGitChangelogProcessOptions,
) {
  const installedState =
    options.currentRelease || options.previousRelease
      ? {
          currentRelease: options.currentRelease,
          previousRelease: options.previousRelease,
        }
      : readInstalledRinReleaseState(options.runtimeDir);
  const range = resolveRinGitChangelogRange({
    lastVersion: options.lastVersion,
    ...installedState,
  });
  if (!range) return;
  if (!range.baseRef) {
    await options.setLastVersion(range.currentRef);
    return;
  }
  if (process.env.RIN_SKIP_VERSION_CHECK || process.env.RIN_OFFLINE) return;

  const notice = await fetchRinGitChangelogNotice({
    baseRef: range.baseRef,
    currentRef: range.currentRef,
    repoUrl: options.repoUrl,
    fetch: options.fetch,
  });
  if (notice.commits.length === 0) return;
  const shown = await options.showNotice(notice);
  if (shown !== true) return;
  await options.setLastVersion(range.currentRef);
}

async function latestGitRefForBranch(
  manifest: ReleaseManifest,
  getReleaseRepoUrl: (manifest: ReleaseManifest) => string,
  currentRelease?: InstalledReleaseInfo,
) {
  if (!manifest.git) return undefined;
  const branch = trim(
    currentRelease?.branch || manifest.git.defaultBranch || "main",
  );
  if (!branch) return undefined;
  const repoUrl = trim(manifest.git?.repoUrl) || getReleaseRepoUrl(manifest);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", repoUrl, `refs/heads/${branch}`],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const raw = String(stdout || "").trim();
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
  const {
    getReleaseRepoUrl,
    loadReleaseManifestForNetwork,
    resolveReleaseRequest,
  } = await import("./release.js");
  const manifest =
    options.manifest ||
    (await loadReleaseManifestForNetwork(options.sourceRoot));
  if (channel === "git")
    return await latestGitRefForBranch(
      manifest,
      getReleaseRepoUrl,
      currentRelease,
    );
  return resolveReleaseRequest(manifest, { channel }).version;
}

export async function checkForRinUpdateNotice(
  options: RinUpdateCheckOptions = {},
): Promise<RinUpdateNotice | undefined> {
  if (process.env.RIN_SKIP_VERSION_CHECK) return undefined;
  if (process.env.RIN_OFFLINE) return undefined;
  const { currentRelease, currentVersion, channel } =
    currentUpdateContext(options);
  const latestVersion = await latestRinVersionForChannel({
    ...options,
    currentVersion,
    channel,
  });
  if (channel === "git") {
    const currentRef = currentRelease?.ref || currentVersion;
    if (
      !latestVersion ||
      !isGitHash(currentRef) ||
      gitRefsMatch(latestVersion, currentRef)
    ) {
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
  return "https://github.com/rinchan-hoshino/rin/blob/main/docs/release/CHANGELOG.md";
}

export function readRinChangelogEntries() {
  return parseChangelog(getChangelogPath());
}
