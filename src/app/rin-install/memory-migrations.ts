#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  finalizeTranscriptSearchMigrationForMigration,
  migrateTranscriptSearchIndexForMigration,
  prepareTranscriptSearchMigrationForMigration,
  rollbackTranscriptSearchMigrationForMigration,
} from "../../core/memory/install-migration.js";

export async function main(args = process.argv.slice(2)) {
  const allowedFlags = new Set([
    "--apply",
    "--preflight",
    "--finalize",
    "--rollback",
    "--runtime-quiesced",
  ]);
  const invalidFlag = args.find(
    (argument) =>
      String(argument).startsWith("--") && !allowedFlags.has(String(argument)),
  );
  if (invalidFlag) {
    throw new Error(`memory_install_migration_mode_invalid:${invalidFlag}`);
  }
  const modes = args.filter((argument) =>
    ["--apply", "--preflight", "--finalize", "--rollback"].includes(
      String(argument),
    ),
  );
  if (modes.length > 1) {
    throw new Error(`memory_install_migration_mode_invalid:${modes.join(",")}`);
  }
  const mode = modes[0] || "--apply";
  const installDir = String(
    [...args]
      .reverse()
      .find((argument) => !String(argument).startsWith("--")) || "",
  ).trim();
  if (!installDir)
    throw new Error("memory_install_migration_install_dir_required");
  if (mode === "--preflight") {
    return prepareTranscriptSearchMigrationForMigration(installDir);
  }
  if (mode === "--finalize") {
    return finalizeTranscriptSearchMigrationForMigration(installDir);
  }
  if (mode === "--rollback") {
    return rollbackTranscriptSearchMigrationForMigration(installDir);
  }
  if (mode !== "--apply") {
    throw new Error(`memory_install_migration_mode_invalid:${mode}`);
  }
  return migrateTranscriptSearchIndexForMigration(installDir, {
    runtimeQuiesced: args.includes("--runtime-quiesced"),
  });
}

const isDirectEntry =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: any) {
    console.error(
      String(error?.message || error || "memory_install_migration_failed"),
    );
    process.exit(1);
  }
}
