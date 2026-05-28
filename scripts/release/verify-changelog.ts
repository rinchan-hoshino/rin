#!/usr/bin/env node
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--changelog") {
      args.changelog = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "--version") {
      args.version = nextArgValue(argv, index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: npx tsx scripts/release/verify-changelog.ts --version <x.y.z> [--changelog docs/release/CHANGELOG.md]",
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

function changelogHasVersion(changelogText, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^##\\s+\\[?${escaped}\\]?\\b`, "m");
  return pattern.test(changelogText);
}

const args = parseArgs(process.argv.slice(2));
const version = normalizeVersionHeading(args.version);
const changelogPath = path.resolve(process.cwd(), args.changelog);
const changelogText = fs.readFileSync(changelogPath, "utf8");

if (!changelogHasVersion(changelogText, version)) {
  console.error(
    `Missing Rin changelog entry for ${version} in ${path.relative(process.cwd(), changelogPath)}.`,
  );
  console.error(`Add a section headed \`## ${version}\` before publishing.`);
  process.exit(1);
}

console.log(
  `Verified Rin changelog entry for ${version} in ${path.relative(process.cwd(), changelogPath)}.`,
);
