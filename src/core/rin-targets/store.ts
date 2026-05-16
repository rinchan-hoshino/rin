import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { normalizeTargetName, type RinTargetRecord } from "./registry.js";

export type RinTargetStoreData = {
  defaultTarget?: string;
  targets: RinTargetRecord[];
};

export function targetStorePath(home = os.homedir()) {
  const explicit = safeString(process.env.RIN_TARGETS_FILE).trim();
  if (explicit) return path.resolve(explicit);
  return path.join(home, ".rin", "targets.json");
}

function emptyStore(): RinTargetStoreData {
  return { targets: [] };
}

function normalizeStore(value: unknown): RinTargetStoreData {
  const record = value && typeof value === "object" ? (value as any) : {};
  const targets = Array.isArray(record.targets)
    ? record.targets.filter((target: any) => safeString(target?.name).trim())
    : [];
  const defaultTarget = normalizeTargetName(record.defaultTarget || "");
  return { defaultTarget: defaultTarget || undefined, targets };
}

export function readTargetStore(
  filePath = targetStorePath(),
): RinTargetStoreData {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return emptyStore();
  }
}

export function writeTargetStore(
  data: RinTargetStoreData,
  filePath = targetStorePath(),
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(normalizeStore(data), null, 2)}\n`,
    "utf8",
  );
}

export function listTargets(filePath = targetStorePath()) {
  return readTargetStore(filePath)
    .targets.slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findTarget(name: string, filePath = targetStorePath()) {
  const targetName = normalizeTargetName(name);
  if (!targetName) return undefined;
  return readTargetStore(filePath).targets.find(
    (target) => normalizeTargetName(target.name) === targetName,
  );
}

export function upsertTarget(
  target: Omit<RinTargetRecord, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  },
  filePath = targetStorePath(),
) {
  const name = normalizeTargetName(target.name);
  if (!name) throw new Error("rin_target_name_required");
  const now = nowIso();
  const store = readTargetStore(filePath);
  const existing = store.targets.find(
    (entry) => normalizeTargetName(entry.name) === name,
  );
  const next: RinTargetRecord = {
    ...target,
    name,
    createdAt: target.createdAt || existing?.createdAt || now,
    updatedAt: target.updatedAt || now,
  };
  store.targets = [
    ...store.targets.filter(
      (entry) => normalizeTargetName(entry.name) !== name,
    ),
    next,
  ];
  if (target.default || !store.defaultTarget) store.defaultTarget = name;
  writeTargetStore(store, filePath);
  return next;
}

export function removeTarget(name: string, filePath = targetStorePath()) {
  const targetName = normalizeTargetName(name);
  const store = readTargetStore(filePath);
  const before = store.targets.length;
  store.targets = store.targets.filter(
    (entry) => normalizeTargetName(entry.name) !== targetName,
  );
  if (store.defaultTarget === targetName) store.defaultTarget = undefined;
  writeTargetStore(store, filePath);
  return store.targets.length !== before;
}

export function setDefaultTarget(name: string, filePath = targetStorePath()) {
  const targetName = normalizeTargetName(name);
  const store = readTargetStore(filePath);
  if (
    !store.targets.some(
      (entry) => normalizeTargetName(entry.name) === targetName,
    )
  ) {
    throw new Error(`rin_target_not_found:${targetName}`);
  }
  store.defaultTarget = targetName;
  store.targets = store.targets.map((entry) => ({
    ...entry,
    default: normalizeTargetName(entry.name) === targetName || undefined,
  }));
  writeTargetStore(store, filePath);
}

export function getDefaultTarget(filePath = targetStorePath()) {
  const store = readTargetStore(filePath);
  if (!store.defaultTarget) return undefined;
  return store.targets.find(
    (entry) => normalizeTargetName(entry.name) === store.defaultTarget,
  );
}
