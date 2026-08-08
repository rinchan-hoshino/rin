import { main as runPiCli } from "@earendil-works/pi-coding-agent";

import {
  handlePiConfigCommand,
  handlePiPackageCommand,
  printPiCliHelp,
} from "../pi/private-api.js";
import {
  applyRuntimeProfileEnvironment,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";

/**
 * Let Pi own every Pi package/auth command. Rin only reserves commands whose
 * names have an explicit Rin product meaning (notably `update`).
 */
export type PiCliRoute = "handled" | "rin" | "rin-after-pi";

export async function tryRunPiCliCommand(args: string[]): Promise<PiCliRoute> {
  applyRuntimeProfileEnvironment(resolveRuntimeProfile());
  const runtimeOptions = {};

  if (args[0] === "update") {
    const updateArgs = args.slice(1);
    if (updateArgs.includes("--help") || updateArgs.includes("-h")) {
      await handlePiPackageCommand(args, runtimeOptions);
      process.stdout.write(
        "Rin compatibility: `rin update`, `rin update self`, and `rin update --self` update the Rin runtime instead of the standalone Pi binary.\n",
      );
      return "handled";
    }
    if (updateArgs.includes("--all")) {
      const approvalArgs: string[] = [];
      if (updateArgs.includes("--approve")) approvalArgs.push("--approve");
      if (updateArgs.includes("--no-approve")) {
        approvalArgs.push("--no-approve");
      }
      await handlePiPackageCommand(
        ["update", "--extensions", ...approvalArgs],
        runtimeOptions,
      );
      return "rin-after-pi";
    }
    const rinSelfUpdate =
      updateArgs.length === 0 ||
      updateArgs.every(
        (arg) =>
          arg === "self" ||
          arg === "pi" ||
          arg === "--self" ||
          arg === "--force" ||
          arg === "--approve" ||
          arg === "--no-approve",
      );
    if (rinSelfUpdate) return "rin";
    return (await handlePiPackageCommand(args, runtimeOptions))
      ? "handled"
      : "rin";
  }

  if (await handlePiPackageCommand(args, runtimeOptions)) return "handled";
  if (await handlePiConfigCommand(args, runtimeOptions)) return "handled";

  if (args[0] === "auth") {
    await runPiCli(args, runtimeOptions);
    return "handled";
  }

  return "rin";
}

export function printRinCliHelp(
  rinCommands: ReadonlyArray<readonly [string, string]>,
) {
  printPiCliHelp();
  process.stdout.write(
    "\nRin options (in addition to Pi):\n" +
      "  --managed-session <leaf>  Attach non-interactive work to a managed session leaf\n" +
      "  --timeout <seconds>       Set the Rin frontend request timeout\n" +
      "  --yes                     Confirm Rin update/install prompts non-interactively\n" +
      "  --user <name>             Run against another local user's Rin runtime\n" +
      "  --target <name>           Run against a configured Rin deployment target\n" +
      "\nRin commands (in addition to Pi):\n",
  );
  const width = Math.max(...rinCommands.map(([name]) => name.length));
  for (const [name, description] of rinCommands) {
    process.stdout.write(`  ${name.padEnd(width)}  ${description}\n`);
  }
}
