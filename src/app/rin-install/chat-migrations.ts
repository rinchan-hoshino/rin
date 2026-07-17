#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runChatInstallMigrations } from "../../core/chat/install-migration.js";

export function main(args = process.argv.slice(2)) {
  const installDir = String(args[0] || "").trim();
  if (!installDir)
    throw new Error("chat_install_migration_install_dir_required");
  return runChatInstallMigrations(installDir, args[1]);
}

const isDirectEntry =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error: any) {
    console.error(
      String(error?.message || error || "chat_install_migration_failed"),
    );
    process.exit(1);
  }
}
