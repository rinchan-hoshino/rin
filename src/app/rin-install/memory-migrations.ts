#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  migrateTranscriptSearchIndexForInstall,
  preflightTranscriptSearchMigration,
} from "../../core/memory/install-migration.js";

export async function main(args = process.argv.slice(2)) {
  const preflight = args[0] === "--preflight";
  const positional = preflight ? args.slice(1) : args;
  const installDir = String(positional[0] || "").trim();
  if (!installDir)
    throw new Error("memory_install_migration_install_dir_required");
  return preflight
    ? preflightTranscriptSearchMigration(installDir)
    : migrateTranscriptSearchIndexForInstall(installDir);
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
