#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function argValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || String(value).startsWith("--")) {
    throw new Error(`missing_value:${option}`);
  }
  return String(value).trim();
}

function parseArgs(argv) {
  const args = {
    manifest: "release-manifest.json",
    channel: "stable",
    version: "",
    ref: "",
    packageName: "",
    repoUrl: "",
    branch: "",
    series: "",
    fromBetaVersion: "",
    promotionVersion: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest") {
      args.manifest = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--channel") {
      args.channel = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--version") {
      args.version = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--ref") {
      args.ref = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--package-name") {
      args.packageName = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--repo-url") {
      args.repoUrl = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      args.branch = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--series") {
      args.series = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--from-beta-version") {
      args.fromBetaVersion = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "--promotion-version") {
      args.promotionVersion = argValue(argv, index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: npx tsx scripts/release/update-release-manifest.ts --channel stable|beta|nightly --version <value> [--ref <sha>] [--branch <name>] [--series <major.minor>] [--from-beta-version <value>] [--promotion-version <x.y.z>] [--package-name <name>] [--repo-url <url>] [--manifest <path>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function trim(value) {
  return String(value || "").trim();
}

function buildNpmTarballUrl(packageName, version) {
  const encodedName = encodeURIComponent(packageName);
  const fileBase = packageName.split("/").pop();
  return `https://registry.npmjs.org/${encodedName}/-/${fileBase}-${version}.tgz`;
}

function githubCodeloadRepoPath(repoUrl) {
  const normalizedRepo = trim(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const sshMatch = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(normalizedRepo);
  if (sshMatch?.[1] && sshMatch[2]) {
    return [sshMatch[1], sshMatch[2]].map(encodeURIComponent).join("/");
  }
  try {
    const parsed = new URL(normalizedRepo);
    if (parsed.hostname.toLowerCase() !== "github.com") return "";
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return "";
    return [owner, repo].map(encodeURIComponent).join("/");
  } catch {
    return "";
  }
}

function buildGitHubRefArchiveUrl(repoUrl, ref) {
  const normalizedRepo = trim(repoUrl)
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
  const normalizedRef = trim(ref) || "main";
  const encodedRef = normalizedRef
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const codeloadRepo = githubCodeloadRepoPath(normalizedRepo);
  if (codeloadRepo) {
    return `https://codeload.github.com/${codeloadRepo}/tar.gz/${encodedRef}`;
  }
  return `${normalizedRepo}/archive/${encodedRef}.tar.gz`;
}

const args = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(process.cwd(), args.manifest);
const manifest = readJson(manifestPath);
const channel = trim(args.channel || "stable");
const version = trim(args.version);
const ref = trim(args.ref);
const branch = trim(args.branch);
const series = trim(args.series);
const packageName =
  trim(args.packageName) || trim(manifest.packageName) || "@hoshinorin/rin";
const repoUrl =
  trim(args.repoUrl) ||
  trim(manifest.repoUrl) ||
  "https://github.com/rinchan-hoshino/rin";

if (!version) throw new Error("missing_version");
if (!["stable", "beta", "nightly"].includes(channel)) {
  throw new Error(`unsupported_channel:${channel}`);
}
if ((channel === "beta" || channel === "nightly") && !ref) {
  throw new Error(`${channel}_requires_ref`);
}

manifest.schemaVersion = 2;
manifest.packageName = packageName;
manifest.repoUrl = repoUrl;
manifest.bootstrapBranch = trim(manifest.bootstrapBranch) || "bootstrap";
manifest.train ||= {};
manifest.train.series = series || trim(manifest.train.series) || "0.0";
manifest.train.nightlyBranch =
  branch || trim(manifest.train.nightlyBranch) || "main";
manifest.stable ||= {};
manifest.beta ||= {};
manifest.nightly ||= {};
manifest.git ||= {};
manifest.git.defaultBranch = trim(manifest.git.defaultBranch) || "main";
manifest.git.repoUrl = trim(manifest.git.repoUrl) || repoUrl;

if (channel === "stable") {
  const archiveUrl = buildNpmTarballUrl(packageName, version);
  manifest.stable.version = version;
  manifest.stable.archiveUrl = archiveUrl;
  if (ref) manifest.stable.ref = ref;
  if (trim(args.fromBetaVersion)) {
    manifest.stable.promotedFromBetaVersion = trim(args.fromBetaVersion);
  }
  manifest.stable.versions ||= {};
  manifest.stable.versions[version] = {
    archiveUrl,
    ...(ref ? { ref } : {}),
    ...(trim(args.fromBetaVersion)
      ? { promotedFromBetaVersion: trim(args.fromBetaVersion) }
      : {}),
  };
} else if (channel === "beta") {
  manifest.beta.version = version;
  manifest.beta.ref = ref;
  manifest.beta.archiveUrl = buildGitHubRefArchiveUrl(repoUrl, ref);
  manifest.beta.promotionVersion =
    trim(args.promotionVersion) ||
    trim(manifest.beta.promotionVersion) ||
    version.replace(/-.*/, "") ||
    version;
} else {
  manifest.nightly.version = version;
  manifest.nightly.ref = ref;
  manifest.nightly.branch =
    branch ||
    trim(manifest.nightly.branch) ||
    trim(manifest.train.nightlyBranch) ||
    "main";
  manifest.nightly.archiveUrl = buildGitHubRefArchiveUrl(repoUrl, ref);
}

writeJson(manifestPath, manifest);
console.log(
  `Updated ${path.relative(process.cwd(), manifestPath)} for ${channel} ${version}.`,
);
