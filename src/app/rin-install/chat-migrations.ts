#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  preflightChatInstallMigrations,
  runChatInstallMigrations,
} from "../../core/chat/install-migration.js";

export function main(args = process.argv.slice(2)) {
  const preflight = args[0] === "--preflight";
  const runtimeWillBeQuiesced = args.includes("--runtime-will-be-quiesced");
  const runtimeQuiesced = args.includes("--runtime-quiesced");
  const positional = args.filter((value) => !value.startsWith("--"));
  const installDir = String(positional[0] || "").trim();
  if (!installDir)
    throw new Error("chat_install_migration_install_dir_required");
  return preflight
    ? preflightChatInstallMigrations(installDir, positional[1], {
        runtimeWillBeQuiesced,
      })
    : runChatInstallMigrations(installDir, positional[1], {
        runtimeQuiesced,
      });
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
