#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  finalizeTranscriptSearchMigrationForInstall,
  migrateTranscriptSearchIndexForInstall,
  prepareTranscriptSearchMigrationForInstall,
  rollbackTranscriptSearchMigrationForInstall,
} from "../../core/memory/install-migration.js";

export async function main(args = process.argv.slice(2)) {
  const mode = String(args[0] || "").startsWith("--")
    ? String(args[0])
    : "--apply";
  const positional = mode === "--apply" ? args : args.slice(1);
  const installDir = String(positional[0] || "").trim();
  if (!installDir)
    throw new Error("memory_install_migration_install_dir_required");
  if (mode === "--preflight") {
    return prepareTranscriptSearchMigrationForInstall(installDir);
  }
  if (mode === "--finalize") {
    return finalizeTranscriptSearchMigrationForInstall(installDir);
  }
  if (mode === "--rollback") {
    return rollbackTranscriptSearchMigrationForInstall(installDir);
  }
  if (mode !== "--apply") {
    throw new Error(`memory_install_migration_mode_invalid:${mode}`);
  }
  return migrateTranscriptSearchIndexForInstall(installDir);
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
