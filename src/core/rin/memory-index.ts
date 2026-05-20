import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  repoRootFromHere,
  safeString,
} from "./shared.js";

async function loadMemoryTranscriptsModule() {
  return await import(
    pathToFileURL(
      path.join(repoRootFromHere(), "dist", "core", "memory", "transcripts.js"),
    ).href
  );
}

export type MemoryIndexCliOptions = {
  action: "repair";
  help: boolean;
};

function printMemoryIndexHelp() {
  console.log(
    [
      "rin memory-index repair",
      "",
      "Commands:",
      "  repair    rebuild the memory search index from archived transcripts",
      "",
      "Examples:",
      "  rin memory-index repair",
      "  rin -u rin memory-index repair",
    ].join("\n"),
  );
}

export function parseMemoryIndexArgs(rawArgv: string[]): MemoryIndexCliOptions {
  const args = extractSubcommandArgv(rawArgv, "memory-index");
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = safeString(args[index]).trim();
    if (arg === "--help" || arg === "-h") help = true;
  }

  return { action: "repair", help };
}

function renderRepairResult(result: {
  dbPath: string;
  transcriptRoot: string;
  fileCount: number;
  entryCount: number;
}) {
  return [
    "memory index repaired",
    `dbPath=${result.dbPath}`,
    `transcriptRoot=${result.transcriptRoot}`,
    `fileCount=${String(result.fileCount)}`,
    `entryCount=${String(result.entryCount)}`,
  ].join("\n");
}

export async function runMemoryIndexInternal(rawArgv: string[]) {
  const options = parseMemoryIndexArgs(rawArgv);
  if (options.help) {
    printMemoryIndexHelp();
    return;
  }

  const agentDir =
    safeString(process.env.RIN_DIR).trim() ||
    path.join(process.env.HOME || "", ".rin");
  const { repairTranscriptSearchIndex } = await loadMemoryTranscriptsModule();
  const result = await repairTranscriptSearchIndex(agentDir);
  console.log(renderRepairResult(result));
}

export async function runMemoryIndex(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseMemoryIndexArgs(rawArgv);
  if (options.help) {
    printMemoryIndexHelp();
    return;
  }

  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    const forwarded = captureInternalRinCommand(
      context,
      "__memory_index_internal",
      rawArgv,
      "memory-index",
    );
    process.stdout.write(forwarded);
    return;
  }

  const { repairTranscriptSearchIndex } = await loadMemoryTranscriptsModule();
  const result = await repairTranscriptSearchIndex(context.installDir);
  console.log(renderRepairResult(result));
}
