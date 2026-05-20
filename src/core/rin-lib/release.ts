import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";

export type ReleaseChannel = "stable" | "beta" | "nightly" | "git";

export type ReleaseRequest = {
  channel?: ReleaseChannel;
  branch?: string;
  version?: string;
};

export type ReleaseManifest = {
  schemaVersion?: number;
  packageName?: string;
  repoUrl?: string;
  bootstrapBranch?: string;
  train?: {
    series?: string;
    nightlyBranch?: string;
  };
  stable?: {
    version?: string;
    archiveUrl?: string;
    ref?: string;
    promotedFromBetaVersion?: string;
    versions?: Record<
      string,
      { archiveUrl?: string; ref?: string; promotedFromBetaVersion?: string }
    >;
  };
  beta?: {
    version?: string;
    archiveUrl?: string;
    ref?: string;
    promotionVersion?: string;
    defaultBranch?: string;
    branches?: Record<string, { version?: string; archiveUrl?: string }>;
    versions?: Record<string, { branch?: string; archiveUrl?: string }>;
  };
  nightly?: {
    version?: string;
    archiveUrl?: string;
    ref?: string;
    branch?: string;
  };
  git?: {
    defaultBranch?: string;
    repoUrl?: string;
  };
};

export type ResolvedRelease = {
  channel: ReleaseChannel;
  archiveUrl: string;
  version: string;
  branch: string;
  ref: string;
  sourceLabel: string;
};

export type InstalledReleaseInfo = ResolvedRelease & {
  installedAt?: string;
};

const DEFAULT_PACKAGE_NAME = "@rinchanai20260422/rin";
const DEFAULT_REPO_URL = "https://github.com/rinchanai/rin";
const DEFAULT_BOOTSTRAP_BRANCH = "bootstrap";
const DEFAULT_TRAIN_SERIES = "0.0";
const DEFAULT_STABLE_VERSION = "0.0.0";
const DEFAULT_BETA_PROMOTION_VERSION = "0.1.0";
const DEFAULT_BETA_VERSION = `${DEFAULT_BETA_PROMOTION_VERSION}-beta.0`;
const DEFAULT_NIGHTLY_VERSION = `${DEFAULT_BETA_PROMOTION_VERSION}-nightly.0`;

function trimReleaseValue(value: unknown) {
  return safeString(value).trim();
}

function firstReleaseValue(...values: unknown[]): string {
  for (const value of values) {
    const text = trimReleaseValue(value);
    if (text) return text;
  }
  return "";
}

function resolveModuleRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

export function buildGitHubRefArchiveUrl(repoUrl: string, ref: string) {
  const normalizedRepo = trimReleaseValue(repoUrl).replace(/\.git$/i, "");
  const normalizedRef = trimReleaseValue(ref) || "main";
  const encodedSegments = normalizedRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${normalizedRepo}/archive/${encodedSegments}.tar.gz`;
}

export function buildGitHubBranchArchiveUrl(repoUrl: string, branch: string) {
  return buildGitHubRefArchiveUrl(repoUrl, `refs/heads/${branch}`);
}

export function buildNpmTarballUrl(packageName: string, version: string) {
  const normalizedName = trimReleaseValue(packageName) || DEFAULT_PACKAGE_NAME;
  const normalizedVersion = trimReleaseValue(version) || DEFAULT_STABLE_VERSION;
  const encodedName = encodeURIComponent(normalizedName);
  const fileBase = normalizedName.split("/").pop() || normalizedName;
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${normalizedVersion}.tgz`;
}

function defaultReleaseManifest(): ReleaseManifest {
  return {
    schemaVersion: 2,
    packageName: DEFAULT_PACKAGE_NAME,
    repoUrl: DEFAULT_REPO_URL,
    bootstrapBranch: DEFAULT_BOOTSTRAP_BRANCH,
    train: {
      series: DEFAULT_TRAIN_SERIES,
      nightlyBranch: "main",
    },
    stable: {
      version: DEFAULT_STABLE_VERSION,
      archiveUrl: buildNpmTarballUrl(
        DEFAULT_PACKAGE_NAME,
        DEFAULT_STABLE_VERSION,
      ),
      ref: "main",
    },
    beta: {
      version: DEFAULT_BETA_VERSION,
      archiveUrl: buildGitHubBranchArchiveUrl(DEFAULT_REPO_URL, "main"),
      ref: "main",
      promotionVersion: DEFAULT_BETA_PROMOTION_VERSION,
    },
    nightly: {
      version: DEFAULT_NIGHTLY_VERSION,
      archiveUrl: buildGitHubBranchArchiveUrl(DEFAULT_REPO_URL, "main"),
      ref: "main",
      branch: "main",
    },
    git: {
      defaultBranch: "main",
      repoUrl: DEFAULT_REPO_URL,
    },
  };
}

export function getBundledReleaseManifestPath(sourceRoot?: string) {
  const root = trimReleaseValue(sourceRoot) || resolveModuleRootFromHere();
  return path.join(root, "release-manifest.json");
}

export function readBundledReleaseManifest(
  sourceRoot?: string,
): ReleaseManifest {
  const manifestPath = getBundledReleaseManifestPath(sourceRoot);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  } catch {
    return defaultReleaseManifest();
  }
}

export function getBootstrapBranch(manifest?: ReleaseManifest) {
  return firstReleaseValue(
    process.env.RIN_BOOTSTRAP_BRANCH,
    manifest?.bootstrapBranch,
    DEFAULT_BOOTSTRAP_BRANCH,
  );
}

export function getReleaseRepoUrl(manifest?: ReleaseManifest) {
  return firstReleaseValue(
    process.env.RIN_INSTALL_REPO_URL,
    manifest?.repoUrl,
    DEFAULT_REPO_URL,
  );
}

export function getReleasePackageName(manifest?: ReleaseManifest) {
  return firstReleaseValue(
    process.env.RIN_NPM_PACKAGE,
    manifest?.packageName,
    DEFAULT_PACKAGE_NAME,
  );
}

function normalizeReleaseChannel(requested: unknown): ReleaseChannel {
  const text = trimReleaseValue(requested).toLowerCase();
  if (text === "beta" || text === "nightly" || text === "git") return text;
  return "stable";
}

function resolveLegacyBetaRelease(
  manifest: ReleaseManifest,
  repoUrl: string,
  request: ReleaseRequest,
): ResolvedRelease {
  const beta = manifest.beta || {};
  const branch = trimReleaseValue(request.branch);
  const version = trimReleaseValue(request.version);
  if (version) {
    const entry = beta.versions?.[version];
    const resolvedBranch = firstReleaseValue(
      entry?.branch,
      beta.defaultBranch,
      "main",
    );
    return {
      channel: "beta",
      archiveUrl:
        firstReleaseValue(entry?.archiveUrl) ||
        buildGitHubRefArchiveUrl(repoUrl, version),
      version,
      branch: resolvedBranch,
      ref: version,
      sourceLabel: `beta version ${version}`,
    };
  }
  const resolvedBranch = firstReleaseValue(branch, beta.defaultBranch, "main");
  const entry = beta.branches?.[resolvedBranch];
  return {
    channel: "beta",
    archiveUrl:
      firstReleaseValue(entry?.archiveUrl) ||
      buildGitHubBranchArchiveUrl(repoUrl, resolvedBranch),
    version: firstReleaseValue(entry?.version, DEFAULT_BETA_VERSION),
    branch: resolvedBranch,
    ref: resolvedBranch,
    sourceLabel: `beta branch ${resolvedBranch}`,
  };
}

export function resolveReleaseRequest(
  manifest: ReleaseManifest,
  request: ReleaseRequest = {},
): ResolvedRelease {
  const channel = normalizeReleaseChannel(request.channel);
  const branch = trimReleaseValue(request.branch);
  const version = trimReleaseValue(request.version);
  const repoUrl = getReleaseRepoUrl(manifest);
  const packageName = getReleasePackageName(manifest);

  if (branch && version) {
    throw new Error("rin_release_branch_and_version_conflict");
  }

  if (channel === "stable") {
    if (branch) throw new Error("rin_stable_branch_not_supported");
    const explicit = version ? manifest.stable?.versions?.[version] : undefined;
    const resolvedVersion = firstReleaseValue(
      version,
      manifest.stable?.version,
      DEFAULT_STABLE_VERSION,
    );
    const resolvedRef = firstReleaseValue(
      explicit?.ref,
      manifest.stable?.ref,
      version,
      manifest.stable?.version,
      "main",
    );
    const archiveUrl =
      firstReleaseValue(explicit?.archiveUrl, manifest.stable?.archiveUrl) ||
      buildNpmTarballUrl(packageName, resolvedVersion);
    return {
      channel,
      archiveUrl,
      version: resolvedVersion,
      branch: "stable",
      ref: resolvedRef,
      sourceLabel: version
        ? `stable version ${resolvedVersion}`
        : `stable ${resolvedVersion}`,
    };
  }

  if (channel === "beta") {
    if (branch || version) {
      return resolveLegacyBetaRelease(manifest, repoUrl, request);
    }
    const resolvedRef = firstReleaseValue(manifest.beta?.ref, "main");
    const resolvedVersion = firstReleaseValue(
      manifest.beta?.version,
      DEFAULT_BETA_VERSION,
    );
    return {
      channel,
      archiveUrl:
        firstReleaseValue(manifest.beta?.archiveUrl) ||
        buildGitHubRefArchiveUrl(repoUrl, resolvedRef),
      version: resolvedVersion,
      branch: "beta",
      ref: resolvedRef,
      sourceLabel: `beta ${resolvedVersion}`,
    };
  }

  if (channel === "nightly") {
    if (branch || version)
      throw new Error("rin_nightly_selector_not_supported");
    const resolvedBranch = firstReleaseValue(
      manifest.nightly?.branch,
      manifest.train?.nightlyBranch,
      manifest.git?.defaultBranch,
      "main",
    );
    const explicitRef = firstReleaseValue(manifest.nightly?.ref);
    const resolvedRef = explicitRef || resolvedBranch;
    const resolvedVersion = firstReleaseValue(
      manifest.nightly?.version,
      DEFAULT_NIGHTLY_VERSION,
    );
    return {
      channel,
      archiveUrl:
        firstReleaseValue(manifest.nightly?.archiveUrl) ||
        (explicitRef
          ? buildGitHubRefArchiveUrl(repoUrl, resolvedRef)
          : buildGitHubBranchArchiveUrl(repoUrl, resolvedBranch)),
      version: resolvedVersion,
      branch: resolvedBranch,
      ref: resolvedRef,
      sourceLabel: `nightly ${resolvedVersion}`,
    };
  }

  const gitRepoUrl = firstReleaseValue(manifest.git?.repoUrl, repoUrl);
  const resolvedBranch = firstReleaseValue(
    branch,
    manifest.git?.defaultBranch,
    "main",
  );
  const resolvedRef = version || resolvedBranch;
  return {
    channel,
    archiveUrl: version
      ? buildGitHubRefArchiveUrl(gitRepoUrl, resolvedRef)
      : buildGitHubBranchArchiveUrl(gitRepoUrl, resolvedBranch),
    version: version || resolvedRef,
    branch: resolvedBranch,
    ref: resolvedRef,
    sourceLabel: version
      ? `git ref ${resolvedRef}`
      : `git branch ${resolvedRef}`,
  };
}

export async function fetchReleaseManifest(
  manifestUrl?: string,
  fallbackManifestUrl?: string,
): Promise<ReleaseManifest> {
  const urls = [
    trimReleaseValue(manifestUrl),
    trimReleaseValue(fallbackManifestUrl),
  ].filter(Boolean);
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      return (await response.json()) as ReleaseManifest;
    } catch {}
  }
  return readBundledReleaseManifest();
}

function getBootstrapManifestUrls(manifest?: ReleaseManifest) {
  const repoUrl = getReleaseRepoUrl(manifest);
  const bootstrapBranch = getBootstrapBranch(manifest);
  const rawBase = repoUrl
    .replace(/^https?:\/\/github\.com\//, "https://raw.githubusercontent.com/")
    .replace(/\.git$/i, "");
  return {
    primary: `${rawBase}/${bootstrapBranch}/release-manifest.json`,
    fallback: `${rawBase}/main/release-manifest.json`,
  };
}

export async function loadReleaseManifestForNetwork(sourceRoot?: string) {
  const bundled = readBundledReleaseManifest(sourceRoot);
  const { primary, fallback } = getBootstrapManifestUrls(bundled);
  return await fetchReleaseManifest(primary, fallback);
}

export function releaseInfoFromObject(
  value: unknown,
): InstalledReleaseInfo | undefined {
  const record = value && typeof value === "object" ? (value as any) : {};
  const channel = normalizeReleaseChannel(record.channel);
  const version = trimReleaseValue(record.version);
  const branch = trimReleaseValue(record.branch);
  const ref = firstReleaseValue(record.ref, branch, version);
  const sourceLabel = trimReleaseValue(record.sourceLabel);
  const archiveUrl = trimReleaseValue(record.archiveUrl);
  if (!version && !branch && !ref && !sourceLabel && !archiveUrl) {
    return undefined;
  }
  return {
    channel,
    version: firstReleaseValue(version, ref, branch, "unknown"),
    branch: firstReleaseValue(branch, channel === "stable" ? "stable" : "main"),
    ref: firstReleaseValue(ref, branch, version, "main"),
    sourceLabel:
      sourceLabel ||
      `${channel} ${firstReleaseValue(version, branch, ref, "unknown")}`,
    archiveUrl,
    installedAt: trimReleaseValue(record.installedAt) || nowIso(),
  };
}

export function releaseInfoFromFile(
  filePath: string | undefined,
): InstalledReleaseInfo | undefined {
  const resolvedPath = trimReleaseValue(filePath);
  if (!resolvedPath) return undefined;
  try {
    return releaseInfoFromObject(
      JSON.parse(fs.readFileSync(resolvedPath, "utf8")),
    );
  } catch {
    return undefined;
  }
}
