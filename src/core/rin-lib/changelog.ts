import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "./runtime.js";

const CHANGELOG_RELATIVE_PATH = ["docs", "release", "CHANGELOG.md"] as const;

export function getChangelogPath() {
  const { agentDir } = resolveRuntimeProfile();
  const candidates = Array.from(
    new Set([
      path.join(agentDir, ...CHANGELOG_RELATIVE_PATH),
      path.join(os.homedir(), ".rin", ...CHANGELOG_RELATIVE_PATH),
    ]),
  );
  return (
    candidates.find((filePath) => fs.existsSync(filePath)) || candidates[0]
  );
}

function normalizeChangelogText(text: string) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function isMissingPathError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function readChangelogText(changelogPath: string) {
  try {
    return fs.readFileSync(changelogPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

export function parseChangelog(changelogPath: string) {
  const text = readChangelogText(changelogPath);
  if (text === undefined) return [];
  const lines = normalizeChangelogText(text).split("\n");
  const entries: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  const flushCurrentEntry = () => {
    const heading = String(currentHeading || "").trim();
    const body = currentBody.join("\n").trim();
    if (heading && body) {
      entries.push({
        heading,
        content: `## ${heading}\n${body}`,
      });
    }
    currentBody = [];
  };

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      flushCurrentEntry();
      currentHeading = line.replace(/^##\s+/, "").trim();
      continue;
    }
    if (!currentHeading) continue;
    currentBody.push(line);
  }

  flushCurrentEntry();
  return entries;
}
