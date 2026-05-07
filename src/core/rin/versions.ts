import {
  currentInstalledReleaseName,
  ensureDir,
  listInstalledReleaseEntries,
  pruneInstalledReleases,
  readInstallerJson,
  runPrivileged,
  switchInstalledCurrentRelease,
  writeJsonFile,
  writeJsonFileWithPrivilege,
} from "../rin-install/fs-utils.js";
import {
  installedReleaseRoot,
  installerManifestPaths,
} from "../rin-install/paths.js";
import { reconcileInstallerManifest } from "../rin-install/persist.js";
import {
  describeOwnership,
  findSystemUser,
  shouldUseElevatedWrite,
  targetHomeForUser,
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

function readRollbackReleaseRecord(
  installDir: string,
  targetUser: string,
  elevated: boolean,
) {
  const manifestPaths = installerManifestPaths(
    installDir,
    targetHomeForUser(targetUser),
  );
  for (const filePath of manifestPaths.recoveryPaths) {
    const manifest = readInstallerJson<any>(filePath, null, elevated);
    const previousRelease = manifest?.previousRelease;
    const name = String(previousRelease?.name || "").trim();
    if (name) return previousRelease;
  }
  return undefined;
}

export async function runRollback(parsed: ParsedArgs) {
  const installDir = resolveInstallDirForTarget(parsed);
  const elevated = shouldUseElevatedInstallAccess(
    parsed.targetUser,
    installDir,
  );
  const currentName = currentInstalledReleaseName(installDir, elevated);
  const rollbackRecord = readRollbackReleaseRecord(
    installDir,
    parsed.targetUser,
    elevated,
  );
  const rollbackName = String(rollbackRecord?.name || "").trim();
  if (!rollbackName) throw new Error("rin_rollback_no_previous_release");
  if (rollbackName === currentName) {
    throw new Error(`rin_rollback_target_is_current:${rollbackName}`);
  }

  const switched = switchInstalledCurrentRelease(
    installDir,
    rollbackName,
    parsed.targetUser,
    elevated,
    { findSystemUser },
  );
  const prunedReleases = pruneInstalledReleases(
    installDir,
    3,
    switched.releaseRoot,
    elevated,
  );
  reconcileInstallerManifest(
    {
      targetUser: parsed.targetUser,
      installDir,
      release: rollbackRecord?.release,
      currentReleaseName: rollbackName,
      currentReleaseRoot: switched.releaseRoot,
      previousReleaseName: currentName,
      previousReleaseRoot: currentName
        ? installedReleaseRoot(installDir, currentName)
        : undefined,
      elevated,
    },
    {
      findSystemUser,
      ensureDir,
      readInstallerJson,
      writeJsonFileWithPrivilege,
      writeJsonFile,
      runPrivileged,
    },
  );

  console.log(
    `rin rollback: switched ${currentName || "current"} -> ${rollbackName}`,
  );
  console.log(`rin rollback: current = ${switched.currentLink}`);
  console.log(`rin rollback: release = ${switched.releaseRoot}`);
  console.log(
    `rin rollback: pruned old releases = ${prunedReleases.removed.length}`,
  );
  await runRestart(parsed);
}
