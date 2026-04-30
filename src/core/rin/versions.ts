import {
  currentInstalledReleaseName,
  listInstalledReleaseEntries,
  rollbackInstalledRuntime,
} from "../rin-install/fs-utils.js";
import {
  describeOwnership,
  findSystemUser,
  shouldUseElevatedWrite,
} from "../rin-install/users.js";

import { runRestart } from "./control.js";
import { ParsedArgs, resolveInstallDirForTarget } from "./shared.js";

function releaseSortNewestFirst(
  a: { name: string; mtimeMs: number },
  b: { name: string; mtimeMs: number },
) {
  const byTime = b.mtimeMs - a.mtimeMs;
  if (byTime) return byTime;
  return b.name.localeCompare(a.name);
}

function shouldUseElevatedInstallAccess(
  targetUser: string,
  installDir: string,
) {
  return shouldUseElevatedWrite(
    targetUser,
    describeOwnership(targetUser, installDir),
  );
}

export function runVersions(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);
  const elevated = shouldUseElevatedInstallAccess(
    parsed.targetUser,
    installDir,
  );
  const currentName = currentInstalledReleaseName(installDir, elevated);
  const entries = listInstalledReleaseEntries(installDir, elevated).sort(
    releaseSortNewestFirst,
  );

  if (!entries.length) {
    console.log(`No installed Rin runtime versions found at ${installDir}.`);
    return;
  }

  console.log(
    `Installed Rin runtime versions for ${parsed.targetUser} at ${installDir}:`,
  );
  for (const entry of entries) {
    const marker = entry.name === currentName ? "*" : " ";
    const suffix = entry.name === currentName ? " (current)" : "";
    console.log(`${marker} ${entry.name}${suffix}`);
  }
}

export async function runRollback(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);
  const elevated = shouldUseElevatedInstallAccess(
    parsed.targetUser,
    installDir,
  );
  const result = rollbackInstalledRuntime(
    installDir,
    parsed.targetUser,
    elevated,
    { findSystemUser },
  );

  console.log(
    `rin rollback: switched ${result.previousReleaseName || "current"} -> ${result.releaseName}`,
  );
  console.log(`rin rollback: current = ${result.currentLink}`);
  console.log(`rin rollback: release = ${result.releaseRoot}`);
  console.log(
    `rin rollback: pruned old releases = ${result.prunedReleases.removed.length}`,
  );
  await runRestart(parsed);
}
