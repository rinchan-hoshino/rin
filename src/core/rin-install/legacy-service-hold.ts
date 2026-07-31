import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type LegacySystemdUnitHoldState = "none" | "owned" | "ambiguous";

function lstatIfPresent(filePath: string) {
  try {
    return fs.lstatSync(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function fsyncParentDirectory(filePath: string) {
  const fd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sameFile(
  left: Pick<fs.Stats, "dev" | "ino">,
  right: Pick<fs.Stats, "dev" | "ino">,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function legacyHoldError(unitPath: string, cause?: unknown) {
  return new Error(`rin_systemd_legacy_hold_ambiguous:${unitPath}`, {
    cause,
  });
}

function isDevNullSymlink(filePath: string, entry: fs.Stats | null) {
  if (!entry?.isSymbolicLink()) return false;
  try {
    return fs.readlinkSync(filePath) === "/dev/null";
  } catch {
    return false;
  }
}

function restoreEntryNoReplace(quarantinedPath: string, originalPath: string) {
  try {
    const entry = fs.lstatSync(quarantinedPath);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(quarantinedPath), originalPath);
    } else if (entry.isFile()) {
      fs.linkSync(quarantinedPath, originalPath);
    } else {
      return;
    }
    fs.unlinkSync(quarantinedPath);
  } catch {}
}

function classifyLegacySystemdUnitHold(
  unitPath: string,
): LegacySystemdUnitHoldState {
  try {
    const heldPath = `${unitPath}.rin-update-hold`;
    const unitEntry = lstatIfPresent(unitPath);
    const heldEntry = lstatIfPresent(heldPath);
    if (!heldEntry) return "none";
    if (heldEntry.isFile() && isDevNullSymlink(unitPath, unitEntry)) {
      return "owned";
    }
    return "ambiguous";
  } catch (cause) {
    throw legacyHoldError(unitPath, cause);
  }
}

export function recoverOwnedLegacySystemdUnitHold(
  unitPath: string,
  options: { runtimeMaskPath?: string } = {},
) {
  const state = classifyLegacySystemdUnitHold(unitPath);
  if (state === "none") return false;
  if (state === "ambiguous") throw legacyHoldError(unitPath);

  const heldPath = `${unitPath}.rin-update-hold`;
  const runtimeMaskPath = options.runtimeMaskPath;
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const quarantinedHeldPath = `${heldPath}.rin-recovery-${token}`;
  const quarantinedUnitMaskPath = `${unitPath}.rin-recovery-mask-${token}`;
  const quarantinedRuntimeMaskPath = runtimeMaskPath
    ? `${runtimeMaskPath}.rin-recovery-mask-${token}`
    : "";
  let heldQuarantined = false;
  let unitMaskQuarantined = false;
  let runtimeMaskQuarantined = false;
  let unitPublished = false;

  try {
    const initialHeld = fs.lstatSync(heldPath);
    const initialUnitMask = fs.lstatSync(unitPath);
    if (!initialHeld.isFile() || !isDevNullSymlink(unitPath, initialUnitMask)) {
      throw legacyHoldError(unitPath);
    }
    const initialRuntimeMask = runtimeMaskPath
      ? lstatIfPresent(runtimeMaskPath)
      : null;
    if (
      runtimeMaskPath &&
      initialRuntimeMask &&
      !isDevNullSymlink(runtimeMaskPath, initialRuntimeMask)
    ) {
      throw legacyHoldError(unitPath);
    }

    fs.renameSync(heldPath, quarantinedHeldPath);
    heldQuarantined = true;
    const quarantinedHeld = fs.lstatSync(quarantinedHeldPath);
    if (!quarantinedHeld.isFile() || !sameFile(initialHeld, quarantinedHeld)) {
      throw legacyHoldError(unitPath);
    }

    fs.renameSync(unitPath, quarantinedUnitMaskPath);
    unitMaskQuarantined = true;
    const quarantinedUnitMask = fs.lstatSync(quarantinedUnitMaskPath);
    if (
      !sameFile(initialUnitMask, quarantinedUnitMask) ||
      !isDevNullSymlink(quarantinedUnitMaskPath, quarantinedUnitMask)
    ) {
      throw legacyHoldError(unitPath);
    }

    if (runtimeMaskPath && initialRuntimeMask) {
      fs.renameSync(runtimeMaskPath, quarantinedRuntimeMaskPath);
      runtimeMaskQuarantined = true;
      const quarantinedRuntimeMask = fs.lstatSync(quarantinedRuntimeMaskPath);
      if (
        !sameFile(initialRuntimeMask, quarantinedRuntimeMask) ||
        !isDevNullSymlink(quarantinedRuntimeMaskPath, quarantinedRuntimeMask)
      ) {
        throw legacyHoldError(unitPath);
      }
    }

    // The quarantined payload is already the validated regular file. link()
    // publishes it atomically without replacing a concurrent administrator unit.
    fs.linkSync(quarantinedHeldPath, unitPath);
    unitPublished = true;
    fsyncParentDirectory(unitPath);

    // Publication is the commit point. Cleanup failures leave only uniquely
    // named evidence artifacts; they never re-mask or replace the active unit.
    try {
      fs.unlinkSync(quarantinedHeldPath);
      heldQuarantined = false;
    } catch {}
    try {
      fs.unlinkSync(quarantinedUnitMaskPath);
      unitMaskQuarantined = false;
    } catch {}
    if (runtimeMaskQuarantined) {
      try {
        fs.unlinkSync(quarantinedRuntimeMaskPath);
        runtimeMaskQuarantined = false;
      } catch {}
    }
    fsyncParentDirectory(unitPath);
    if (runtimeMaskPath && initialRuntimeMask) {
      fsyncParentDirectory(runtimeMaskPath);
    }
    return true;
  } catch (error) {
    if (!unitPublished) {
      if (heldQuarantined) {
        restoreEntryNoReplace(quarantinedHeldPath, heldPath);
      }
      if (unitMaskQuarantined) {
        restoreEntryNoReplace(quarantinedUnitMaskPath, unitPath);
      }
      if (runtimeMaskQuarantined && runtimeMaskPath) {
        restoreEntryNoReplace(quarantinedRuntimeMaskPath, runtimeMaskPath);
      }
    }
    throw String((error as any)?.message || "").startsWith(
      "rin_systemd_legacy_hold_ambiguous:",
    )
      ? error
      : legacyHoldError(unitPath, error);
  }
}
