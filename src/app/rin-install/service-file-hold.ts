import { pathToFileURL } from "node:url";

import {
  setSystemdUnitFileHold,
  setWindowsStartupEntryHold,
} from "../../core/rin/managed-runtime-service.js";

export function main(args = process.argv.slice(2)) {
  const kind = String(args[0] || "");
  const mode = String(args[1] || "");
  const filePath = String(args[2] || "").trim();
  if (!filePath || (mode !== "hold" && mode !== "release")) {
    throw new Error("rin_service_file_hold_arguments_invalid");
  }
  const hold = mode === "hold";
  if (kind === "systemd") {
    return setSystemdUnitFileHold(filePath, hold);
  }
  if (kind === "windows-startup") {
    return setWindowsStartupEntryHold(filePath, hold);
  }
  throw new Error(`rin_service_file_hold_kind_invalid:${kind}`);
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(entryArg).href) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
