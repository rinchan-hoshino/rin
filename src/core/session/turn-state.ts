import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

function forEachSessionFileEntry(
  sessionFile: string,
  visitor: (entry: any) => void,
): boolean {
  try {
    const text = fs.readFileSync(sessionFile, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        visitor(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readLastSessionFileEntry(sessionFile: string) {
  let lastEntry: any;
  if (
    !forEachSessionFileEntry(sessionFile, (entry) => {
      lastEntry = entry;
    })
  ) {
    return undefined;
  }
  return lastEntry;
}

export function shouldContinueInterruptedTurn(sessionFile: string) {
  const tail = readLastSessionFileEntry(sessionFile);
  if (tail?.type !== "message") return false;
  return !isCompletedAssistantMessageEntry(tail);
}

export function listSessionFiles(sessionDir: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(fullPath);
      }
    }
  };
  visit(sessionDir);
  return result.sort();
}

export function listContinuableInterruptedTurnSessionFiles(
  sessionDir: string,
): string[] {
  return listSessionFiles(sessionDir).filter((sessionFile) =>
    shouldContinueInterruptedTurn(sessionFile),
  );
}

function hasToolCallContent(content: unknown) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    return (
      safeString((part as any).type)
        .trim()
        .toLowerCase() === "toolcall"
    );
  });
}

function isCompletedAssistantMessageEntry(entry: any) {
  const message = entry?.message;
  const role = safeString(message?.role).trim();
  if (role !== "assistant") return false;
  return !hasToolCallContent(message?.content);
}
