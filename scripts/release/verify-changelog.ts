#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function trim(value) {
  return String(value || "").trim();
}

function nextArgValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || String(value).startsWith("--")) {
    throw new Error(`missing_value:${option}`);
  }
  return trim(value);
}

function parseArgs(argv) {
  const args = {
    changelog: "docs/release/CHANGELOG.md",
    version: "",
    fromRef: "",
    toRef: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--changelog") {
      args.changelog = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--version") {
      args.version = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--from-ref") {
      args.fromRef = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--to-ref") {
      args.toRef = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: npx tsx scripts/release/verify-changelog.ts --version <x.y.z> [--changelog docs/release/CHANGELOG.md] [--from-ref <sha> --to-ref <sha>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown_argument:${arg}`);
    }
  }
  return args;
}

function normalizeVersionHeading(version) {
  const normalized = trim(version).replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`invalid_version:${version}`);
  }
  return normalized;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findVersionSection(changelogText, version) {
  const escaped = escapeRegExp(version);
  const headingPattern = new RegExp(`^##\\s+\\[?${escaped}\\]?\\b.*$`, "m");
  const match = headingPattern.exec(changelogText);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const nextHeadingPattern = /^##\s+/gm;
  nextHeadingPattern.lastIndex = bodyStart;
  const nextHeading = nextHeadingPattern.exec(changelogText);
  return changelogText.slice(bodyStart, nextHeading?.index).trim();
}

function releaseNoteBullets(sectionText) {
  return sectionText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line));
}

function validateCoverageArgs(args) {
  if (args.fromRef && !args.toRef) throw new Error("missing_value:--to-ref");
  if (args.toRef && !args.fromRef) throw new Error("missing_value:--from-ref");
}

function gitLogCommits(fromRef, toRef) {
  const output = execFileSync(
    "git",
    ["log", "--no-merges", "--format=%H%x00%s", `${fromRef}..${toRef}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split("\0");
      return { sha: trim(sha), subject: trim(subject) };
    })
    .filter((commit) => commit.sha && commit.subject);
}

function isReleaseMetadataCommit(subject) {
  return (
    /^chore\(release\):\s+(?:publish|cut|promote)\b/i.test(subject) ||
    /^docs\(release\):\s+(?:add|update)\b.*\bchangelog\b/i.test(subject)
  );
}

function commitCoverageToken(commit) {
  return commit.sha.slice(0, 7);
}

function missingCoveredCommits(sectionText, commits) {
  return commits.filter(
    (commit) => !sectionText.includes(commitCoverageToken(commit)),
  );
}

const args = parseArgs(process.argv.slice(2));
validateCoverageArgs(args);
const version = normalizeVersionHeading(args.version);
const changelogPath = path.resolve(process.cwd(), args.changelog);
const changelogText = fs.readFileSync(changelogPath, "utf8");
const sectionText = findVersionSection(changelogText, version);

if (sectionText === null) {
  console.error(
    `Missing Rin changelog entry for ${version} in ${path.relative(process.cwd(), changelogPath)}.`,
  );
  console.error(`Add a section headed \`## ${version}\` before publishing.`);
  process.exit(1);
}

const bullets = releaseNoteBullets(sectionText);
if (bullets.length === 0) {
  console.error(
    `Missing Rin changelog content for ${version} in ${path.relative(process.cwd(), changelogPath)}.`,
  );
  console.error("Add at least one user-facing release-note bullet.");
  process.exit(1);
}

let coveredCommitCount = 0;
if (args.fromRef && args.toRef) {
  const commits = gitLogCommits(args.fromRef, args.toRef).filter(
    (commit) => !isReleaseMetadataCommit(commit.subject),
  );
  const missingCommits = missingCoveredCommits(sectionText, commits);
  coveredCommitCount = commits.length;
  if (missingCommits.length > 0) {
    console.error(`Missing Rin changelog coverage for ${version}:`);
    for (const commit of missingCommits) {
      console.error(`- ${commitCoverageToken(commit)} ${commit.subject}`);
    }
    console.error(
      "Add a `<!-- rin-changelog-coverage ... -->` block in the version section with each covered commit short SHA and subject.",
    );
    process.exit(1);
  }
}

const coverageSuffix = args.fromRef
  ? ` and ${coveredCommitCount} covered commit${coveredCommitCount === 1 ? "" : "s"}`
  : "";
console.log(
  `Verified Rin changelog entry for ${version}${coverageSuffix} in ${path.relative(process.cwd(), changelogPath)}.`,
);
