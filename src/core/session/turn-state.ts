import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

const LAST_ENTRY_SCAN_CHUNK_SIZE = 64 * 1024;

function parseJsonLine(line: Buffer) {
  const text = line.toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readLastSessionFileEntry(sessionFile: string) {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sessionFile, "r");
    const { size } = fs.fstatSync(fd);
    let position = size;
    let pending = Buffer.alloc(0);

    while (position > 0) {
      const readSize = Math.min(LAST_ENTRY_SCAN_CHUNK_SIZE, position);
      position -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      const data = pending.length ? Buffer.concat([chunk, pending]) : chunk;
      let lineEnd = data.length;

      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index] !== 0x0a) continue;
        const parsed = parseJsonLine(data.subarray(index + 1, lineEnd));
        if (parsed) return parsed;
        lineEnd = index;
      }

      pending = data.subarray(0, lineEnd);
    }

    return parseJsonLine(pending);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
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
