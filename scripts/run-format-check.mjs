#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const formatterModes = new Set(["check", "write"]);

export function parseFormatArgs(argv = []) {
  const first = String(argv[0] || "").trim();
  const mode = first.startsWith("--") ? first.slice(2) : "check";
  if (formatterModes.has(mode) && first.startsWith("--")) {
    return { mode, targets: argv.slice(1) };
  }
  return { mode: "check", targets: argv };
}

export function buildPrettierFormatArgs({ mode = "check", targets = [] } = {}) {
  const normalizedMode = formatterModes.has(mode) ? mode : "check";
  return [
    `--${normalizedMode}`,
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ...(targets.length > 0 ? targets : ["."]),
  ];
}

export function buildPrettierFormatCheckArgs(targets = []) {
  return buildPrettierFormatArgs({ mode: "check", targets });
}

export function buildPrettierFormatWriteArgs(targets = []) {
  return buildPrettierFormatArgs({ mode: "write", targets });
}

export function main(argv = process.argv.slice(2)) {
  const formatArgs = parseFormatArgs(argv);
  const result = spawnSync("prettier", buildPrettierFormatArgs(formatArgs), {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
