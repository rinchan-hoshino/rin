import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeStoredChatSettings } from "../chat/settings.js";
import {
  chatDataPath,
  LEGACY_DATA_LAYOUT_MOVES,
  schedulerDataPath,
} from "../data-layout.js";
import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "../chat/support.js";
import { isJsonRecord } from "../json-utils.js";
import { DEFAULT_LANGUAGE_TAG, normalizeLanguageTag } from "../language.js";
import { stringifyJson } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { loadFirstValidCandidate } from "./candidate-loader.js";
import { type InstalledReleaseInfo } from "../rin-lib/release.js";
import { getManagedChatSessionDir } from "../session/managed-paths.js";
import {
  defaultHomeForUser,
  installAuthPath,
  installerManifestPaths,
  installSettingsPath,
} from "./paths.js";

export type ManagedFilesManifest = {
  trees: Record<string, string[]>;
};

function resolveInstallOwner(
  targetUser: string,
  findSystemUser: (targetUser: string) => any,
) {
  const target = findSystemUser(targetUser) as any;
  const ownerUser = target?.name || targetUser;
  return {
    ownerUser,
    ownerGroup: target?.gid,
    ownerHome: target?.home || defaultHomeForUser(ownerUser),
  };
}

function writeInstallerJson(
  filePath: string,
  value: unknown,
  options: {
    elevated?: boolean;
    ownerUser?: string;
    ownerGroup?: string | number;
  },
  deps: {
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
  },
) {
  if (options.elevated) {
    deps.writeJsonFileWithPrivilege(
      filePath,
      value,
      options.ownerUser,
      options.ownerGroup,
    );
    return;
  }
  deps.writeJsonFile(filePath, value);
}

function removeFile(
  filePath: string,
  elevated: boolean,
  runPrivileged: (command: string, args: string[]) => void,
) {
  try {
    if (elevated) {
      runPrivileged("rm", ["-f", filePath]);
      return;
    }
    fs.rmSync(filePath, { force: true });
  } catch {}
}

type InstallPathMoveResult = {
  id: string;
  fromPath: string;
  toPath: string;
  moved: boolean;
  skipped: boolean;
};

type InstallMigrationCommandDeps = {
  runPrivileged: (command: string, args: string[]) => void;
  runCommandAsUser?: (
    targetUser: string,
    command: string,
    args: string[],
  ) => void;
  captureCommandAsUser?: (
    targetUser: string,
    command: string,
    args: string[],
  ) => string;
};

type InstallMigrationOptions = {
  targetUser: string;
  elevated?: boolean;
};

type InstallMigrationFileOps = {
  pathExists: (filePath: string) => boolean;
  readJsonObject: (filePath: string) => Record<string, unknown> | null;
  writeJsonObject: (filePath: string, value: unknown) => void;
  ensureDir: (dirPath: string) => void;
  rename: (fromPath: string, toPath: string) => void;
};

function parseJsonObject(text: string) {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function runMigrationCommandAsTargetUser(
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
  command: string,
  args: string[],
) {
  if (!deps.runCommandAsUser) {
    throw new Error("Install migration requires target-user command support.");
  }
  deps.runCommandAsUser(options.targetUser, command, args);
}

function writeTextFileAsTargetUser(
  filePath: string,
  value: string,
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
  mode = 0o600,
) {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "rin-install-migration-write-"),
  );
  const tempFile = path.join(tempDir, "payload");
  try {
    fs.chmodSync(tempDir, 0o755);
    fs.writeFileSync(tempFile, value, "utf8");
    fs.chmodSync(tempFile, 0o644);
    runMigrationCommandAsTargetUser(options, deps, "mkdir", [
      "-p",
      path.dirname(filePath),
    ]);
    runMigrationCommandAsTargetUser(options, deps, "install", [
      "-m",
      mode.toString(8),
      tempFile,
      filePath,
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createInstallMigrationFileOps(
  options: InstallMigrationOptions,
  deps: InstallMigrationCommandDeps,
): InstallMigrationFileOps {
  const elevated = Boolean(options.elevated);
  return {
    pathExists(filePath: string) {
      try {
        fs.accessSync(filePath);
        return true;
      } catch (error: any) {
        const code = String(error?.code || "");
        if ((code === "EACCES" || code === "EPERM") && elevated) {
          try {
            runMigrationCommandAsTargetUser(options, deps, "test", [
              "-e",
              filePath,
            ]);
            return true;
          } catch {}
        }
        return false;
      }
    },
    readJsonObject(filePath: string) {
      try {
        return parseJsonObject(fs.readFileSync(filePath, "utf8"));
      } catch (error: any) {
        const code = String(error?.code || "");
        if (
          (code === "EACCES" || code === "EPERM") &&
          elevated &&
          deps.captureCommandAsUser
        ) {
          try {
            return parseJsonObject(
              deps.captureCommandAsUser(options.targetUser, "cat", [filePath]),
            );
          } catch {}
        }
        return null;
      }
    },
    writeJsonObject(filePath: string, value: unknown) {
      if (elevated) {
        writeTextFileAsTargetUser(
          filePath,
          stringifyJson(value),
          options,
          deps,
        );
        return;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, stringifyJson(value), "utf8");
    },
    ensureDir(dirPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "mkdir", [
          "-p",
          dirPath,
        ]);
        return;
      }
      fs.mkdirSync(dirPath, { recursive: true });
    },
    rename(fromPath: string, toPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "mv", [
          fromPath,
          toPath,
        ]);
        return;
      }
      fs.renameSync(fromPath, toPath);
    },
  };
}

function moveInstalledPathIfNeeded(
  move: {
    id: string;
    fromPath: string;
    toPath: string;
  },
  fileOps: InstallMigrationFileOps,
): InstallPathMoveResult {
  const hasSource = fileOps.pathExists(move.fromPath);
  if (!hasSource) {
    return { ...move, moved: false, skipped: false };
  }
  const hasTarget = fileOps.pathExists(move.toPath);
  if (hasTarget) {
    return { ...move, moved: false, skipped: true };
  }
  fileOps.ensureDir(path.dirname(move.toPath));
  fileOps.rename(move.fromPath, move.toPath);
  return { ...move, moved: true, skipped: false };
}

type InstallDataLayoutMigrationResult = {
  id: "data-layout-v1";
  skipped: boolean;
  moved: number;
  skippedExistingTarget: number;
  movedPaths: Array<{ id: string; fromPath: string; toPath: string }>;
};

function migrateInstalledDataLayout(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallDataLayoutMigrationResult {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const movedPaths: InstallDataLayoutMigrationResult["movedPaths"] = [];
  let skippedExistingTarget = 0;
  for (const move of LEGACY_DATA_LAYOUT_MOVES) {
    const result = moveInstalledPathIfNeeded(
      {
        id: move.id,
        fromPath: path.join(root, "data", move.from),
        toPath: path.join(root, "data", move.to),
      },
      fileOps,
    );
    if (result.moved) {
      movedPaths.push({
        id: move.id,
        fromPath: result.fromPath,
        toPath: result.toPath,
      });
    } else if (result.skipped) {
      skippedExistingTarget += 1;
    }
  }
  return {
    id: "data-layout-v1",
    skipped: movedPaths.length === 0,
    moved: movedPaths.length,
    skippedExistingTarget,
    movedPaths,
  };
}

const CHAT_STATE_SESSION_FILE_MIGRATION_ID = "chat-state-session-file-v1";
const CHAT_SESSION_MANAGED_FILE_MIGRATION_ID = "chat-session-managed-file-v1";

type InstallStateRewriteResult = {
  id: string;
  markerPath: string;
  alreadyApplied: boolean;
  skipped: boolean;
  scanned: number;
  migrated: number;
  migratedFiles: string[];
};

function uniqueStatePaths(paths: unknown[]) {
  return Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((value) => safeString(value).trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

function rewriteChatStateSessionFileKey(
  statePath: string,
  fileOps: InstallMigrationFileOps,
) {
  const state = fileOps.readJsonObject(statePath);
  if (!state) return false;
  if (!Object.prototype.hasOwnProperty.call(state, "piSessionFile")) {
    return false;
  }

  const nextState: Record<string, unknown> = { ...state };
  const sessionFile = safeString(nextState.sessionFile).trim();
  const previousSessionFile = safeString(nextState.piSessionFile).trim();
  if (!sessionFile && previousSessionFile) {
    nextState.sessionFile = previousSessionFile;
  }
  delete nextState.piSessionFile;
  fileOps.writeJsonObject(statePath, nextState);
  return true;
}

function chatStateSessionFileMigrationMarkerPath(installDir: string) {
  return path.join(
    path.resolve(String(installDir || "").trim() || "."),
    "data",
    "migrations",
    `${CHAT_STATE_SESSION_FILE_MIGRATION_ID}.json`,
  );
}

function rewriteInstalledChatStateSessionFileKeys(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallStateRewriteResult {
  const markerPath = chatStateSessionFileMigrationMarkerPath(installDir);
  const marker = fileOps.readJsonObject(markerPath);
  if (
    marker &&
    safeString(marker.id || marker.migrationId).trim() ===
      CHAT_STATE_SESSION_FILE_MIGRATION_ID
  ) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      skipped: true,
      scanned: 0,
      migrated: 0,
      migratedFiles: [],
    };
  }

  const root = path.resolve(String(installDir || "").trim() || ".");
  const statePaths = uniqueStatePaths([
    ...listChatStateFiles(chatDataPath(root, "session-state")).map(
      (item) => item.statePath,
    ),
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(schedulerDataPath(root, "turns")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(
      path.join(root, "data", "cron-turns"),
    ).map((item) => item.statePath),
  ]);
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    if (!rewriteChatStateSessionFileKey(statePath, fileOps)) continue;
    migratedFiles.push(statePath);
  }

  const scanned = statePaths.length;
  const migrated = migratedFiles.length;
  if (migrated === 0) {
    return {
      id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: false,
      skipped: true,
      scanned,
      migrated,
      migratedFiles,
    };
  }

  fileOps.writeJsonObject(markerPath, {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    appliedAt: nowIso(),
    scanned,
    migrated,
  });
  return {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    skipped: false,
    scanned,
    migrated,
    migratedFiles,
  };
}

function chatSessionManagedFileMigrationMarkerPath(installDir: string) {
  return path.join(
    path.resolve(String(installDir || "").trim() || "."),
    "data",
    "migrations",
    `${CHAT_SESSION_MANAGED_FILE_MIGRATION_ID}.json`,
  );
}

function sessionFilePathForInstalledChatState(
  installDir: string,
  sessionFile: string,
) {
  const sessionsDir = path.join(path.resolve(installDir), "sessions");
  const raw = safeString(sessionFile).trim();
  if (!raw) return null;
  const absolute = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.join(sessionsDir, raw);
  const basename = path.basename(absolute);
  if (!basename.endsWith(".jsonl")) return null;
  if (absolute !== path.join(sessionsDir, basename)) return null;
  return { sessionsDir, absolute, basename };
}

function pickAvailableManagedChatSessionPath(
  managedDir: string,
  basename: string,
  fileOps: InstallMigrationFileOps,
) {
  const parsed = path.parse(basename);
  let candidate = path.join(managedDir, basename);
  let index = 2;
  while (fileOps.pathExists(candidate)) {
    candidate = path.join(
      managedDir,
      `${parsed.name}-${index}${parsed.ext || ".jsonl"}`,
    );
    index += 1;
  }
  return candidate;
}

function migrateChatStateSessionFileToManaged(
  installDir: string,
  statePath: string,
  fileOps: InstallMigrationFileOps,
) {
  const state = fileOps.readJsonObject(statePath);
  if (!state) return "";
  const sessionFile = safeString(state.sessionFile).trim();
  if (!sessionFile || sessionFile.startsWith("managed/")) return "";
  const source = sessionFilePathForInstalledChatState(installDir, sessionFile);
  if (!source) return "";

  const managedDir = getManagedChatSessionDir(installDir);
  const targetPath = pickAvailableManagedChatSessionPath(
    managedDir,
    source.basename,
    fileOps,
  );
  if (!fileOps.pathExists(source.absolute)) return "";
  fileOps.ensureDir(path.dirname(targetPath));
  fileOps.rename(source.absolute, targetPath);

  const nextState: Record<string, unknown> = { ...state };
  nextState.sessionFile = path.relative(source.sessionsDir, targetPath);
  fileOps.writeJsonObject(statePath, nextState);
  return targetPath;
}

function migrateInstalledChatSessionFilesToManaged(
  installDir: string,
  fileOps: InstallMigrationFileOps,
): InstallStateRewriteResult {
  const markerPath = chatSessionManagedFileMigrationMarkerPath(installDir);
  const marker = fileOps.readJsonObject(markerPath);
  if (
    marker &&
    safeString(marker.id || marker.migrationId).trim() ===
      CHAT_SESSION_MANAGED_FILE_MIGRATION_ID
  ) {
    return {
      id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: true,
      skipped: true,
      scanned: 0,
      migrated: 0,
      migratedFiles: [],
    };
  }

  const root = path.resolve(String(installDir || "").trim() || ".");
  const statePaths = uniqueStatePaths([
    ...listChatStateFiles(chatDataPath(root, "session-state")).map(
      (item) => item.statePath,
    ),
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
  ]);
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    const migratedFile = migrateChatStateSessionFileToManaged(
      root,
      statePath,
      fileOps,
    );
    if (migratedFile) migratedFiles.push(migratedFile);
  }

  const scanned = statePaths.length;
  const migrated = migratedFiles.length;
  if (migrated === 0) {
    return {
      id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
      markerPath,
      alreadyApplied: false,
      skipped: true,
      scanned,
      migrated,
      migratedFiles,
    };
  }

  fileOps.writeJsonObject(markerPath, {
    id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
    appliedAt: nowIso(),
    scanned,
    migrated,
  });
  return {
    id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
    markerPath,
    alreadyApplied: false,
    skipped: false,
    scanned,
    migrated,
    migratedFiles,
  };
}

export function applyInstallUpgradeMigrations(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: InstallMigrationCommandDeps,
) {
  const fileOps = createInstallMigrationFileOps(options, deps);
  return [
    migrateInstalledDataLayout(options.installDir, fileOps),
    rewriteInstalledChatStateSessionFileKeys(options.installDir, fileOps),
    migrateInstalledChatSessionFilesToManaged(options.installDir, fileOps),
  ];
}

function normalizeInstallerRecord(value: unknown) {
  return isJsonRecord(value) ? value : {};
}

function normalizeChatConfigRoot(chatConfig: unknown) {
  return isJsonRecord(chatConfig) ? chatConfig : null;
}

function normalizeConfiguredLanguage(language: unknown) {
  const normalizedLanguage = String(language || "").trim();
  return normalizedLanguage
    ? normalizeLanguageTag(normalizedLanguage, DEFAULT_LANGUAGE_TAG)
    : "";
}

function applyInstalledDefaults(
  target: any,
  options: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    language?: string;
  },
) {
  if (options.provider) target.defaultProvider = options.provider;
  if (options.modelId) target.defaultModel = options.modelId;
  if (options.thinkingLevel) {
    target.defaultThinkingLevel = options.thinkingLevel;
  }
  const language = normalizeConfiguredLanguage(options.language);
  if (language) target.language = language;
}

function installerWriteOptions(
  ownerUser: string,
  ownerGroup: string | number | undefined,
  elevated: boolean | undefined,
) {
  return {
    elevated,
    ownerUser,
    ownerGroup,
  };
}

function mergeInstalledChatSettings(settingsJson: any, chatConfig?: any) {
  const normalizedChatConfig = normalizeChatConfigRoot(chatConfig);
  const normalized = normalizeStoredChatSettings(settingsJson, {
    ensureChat: Boolean(normalizedChatConfig),
  });
  if (!normalizedChatConfig) return normalized;
  for (const [adapterKey, adapterConfig] of Object.entries(
    normalizedChatConfig,
  )) {
    if (adapterConfig === undefined) continue;
    normalized.chat[adapterKey] = adapterConfig;
  }
  return normalized;
}

function normalizeInstalledReleaseInfo(
  release: InstalledReleaseInfo | undefined,
): InstalledReleaseInfo | undefined {
  if (!release || typeof release !== "object") return undefined;
  const channel = String(release.channel || "stable")
    .trim()
    .toLowerCase();
  const normalizedChannel =
    channel === "beta" || channel === "nightly" || channel === "git"
      ? channel
      : "stable";
  const version = String(release.version || "").trim();
  const branch = String(release.branch || "").trim();
  const ref = String(release.ref || branch || version).trim();
  const sourceLabel = String(release.sourceLabel || "").trim();
  const archiveUrl = String(release.archiveUrl || "").trim();
  const installedAt = String(release.installedAt || "").trim();
  if (!version && !branch && !ref && !sourceLabel && !archiveUrl)
    return undefined;
  return {
    channel: normalizedChannel,
    version: version || ref || branch || "unknown",
    branch: branch || (normalizedChannel === "stable" ? "stable" : "main"),
    ref: ref || branch || version || "main",
    sourceLabel:
      sourceLabel ||
      `${normalizedChannel} ${version || branch || ref || "unknown"}`,
    archiveUrl,
    installedAt: installedAt || undefined,
  };
}

function isInstalledReleaseRecord(value: any) {
  return isJsonRecord(value) && typeof value.name === "string";
}

function normalizeInstalledReleaseRecord(value: any) {
  if (!isInstalledReleaseRecord(value)) return undefined;
  return buildInstalledReleaseRecord({
    name: value.name,
    root: value.path,
    release: value.release,
  });
}

function buildInstalledReleaseRecord(options: {
  name?: string;
  root?: string;
  release?: InstalledReleaseInfo;
}) {
  const name = String(options.name || "").trim();
  if (!name) return undefined;
  const release = normalizeInstalledReleaseInfo(options.release);
  return {
    name,
    ...(String(options.root || "").trim()
      ? { path: String(options.root || "").trim() }
      : {}),
    ...(release ? { release } : {}),
  };
}

function legacyManagedFilesManifestPath(installDir: string) {
  return path.join(installDir, "data", ".managed", "install-home.json");
}

function normalizeManagedTreeFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          String(entry || "")
            .trim()
            .replace(/\\/g, "/"),
        )
        .filter((entry) => entry && !entry.startsWith("/") && entry !== "."),
    ),
  ).sort();
}

function normalizeManagedFilesManifest(
  value: unknown,
): ManagedFilesManifest | undefined {
  if (!isJsonRecord(value) || !isJsonRecord(value.trees)) return undefined;
  const trees: Record<string, string[]> = {};
  for (const [rawRoot, rawFiles] of Object.entries(value.trees)) {
    const root = String(rawRoot || "")
      .trim()
      .replace(/\\/g, "/");
    if (!root || root.startsWith("/") || root === ".") continue;
    const files = normalizeManagedTreeFiles(rawFiles);
    if (files.length) trees[root] = files;
  }
  return Object.keys(trees).length ? { trees } : undefined;
}

function mergeManagedFilesManifests(
  prior: ManagedFilesManifest | undefined,
  next: ManagedFilesManifest | undefined,
) {
  if (!prior && !next) return undefined;
  return {
    trees: {
      ...(prior?.trees || {}),
      ...(next?.trees || {}),
    },
  };
}

export function reconcileInstallerManifest(
  options: {
    targetUser: string;
    installDir: string;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
    previousReleaseName?: string;
    previousReleaseRoot?: string;
    elevated?: boolean;
    managedFiles?: ManagedFilesManifest;
    service?: {
      kind: "launchd" | "systemd" | "windows-startup";
      label: string;
      path?: string;
    } | null;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  const { ownerUser, ownerGroup, ownerHome } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPaths = installerManifestPaths(options.installDir, ownerHome);
  const { manifestPath, locatorManifestPath } = manifestPaths;
  const writeOptions = installerWriteOptions(
    ownerUser,
    ownerGroup,
    options.elevated,
  );
  const legacyManagedFilesPath = legacyManagedFilesManifestPath(
    options.installDir,
  );
  const priorManifest: any =
    loadFirstValidCandidate(
      manifestPaths.recoveryPaths,
      (filePath) =>
        deps.readInstallerJson<any>(filePath, null, Boolean(options.elevated)),
      (value) => (isJsonRecord(value) ? value : null),
    ) || {};
  const priorManagedFiles =
    normalizeManagedFilesManifest(priorManifest.managedFiles) ||
    normalizeManagedFilesManifest(
      deps.readInstallerJson<any>(
        legacyManagedFilesPath,
        null,
        Boolean(options.elevated),
      ),
    );
  const manifestJson: any = {
    targetUser: options.targetUser,
    installDir: options.installDir,
  };
  const normalizedRelease = normalizeInstalledReleaseInfo(options.release);
  const priorCurrentRelease = normalizeInstalledReleaseRecord(
    priorManifest.currentRelease,
  );
  const priorPreviousRelease = normalizeInstalledReleaseRecord(
    priorManifest.previousRelease,
  );
  const previousReleaseName = String(options.previousReleaseName || "").trim();
  const previousReleaseMetadata = previousReleaseName
    ? priorCurrentRelease?.name === previousReleaseName
      ? priorCurrentRelease.release
      : priorPreviousRelease?.name === previousReleaseName
        ? priorPreviousRelease.release
        : undefined
    : undefined;
  const currentRelease =
    buildInstalledReleaseRecord({
      name: options.currentReleaseName,
      root: options.currentReleaseRoot,
      release: normalizedRelease,
    }) || priorCurrentRelease;
  const previousRelease = buildInstalledReleaseRecord({
    name: options.previousReleaseName,
    root: options.previousReleaseRoot,
    release: previousReleaseMetadata,
  });
  if (currentRelease) manifestJson.currentRelease = currentRelease;
  const managedFiles = mergeManagedFilesManifests(
    priorManagedFiles,
    normalizeManagedFilesManifest(options.managedFiles),
  );
  if (managedFiles) manifestJson.managedFiles = managedFiles;
  if (options.service) {
    manifestJson.service = {
      kind: options.service.kind,
      label: options.service.label,
      ...(options.service.path ? { path: options.service.path } : {}),
    };
  } else if (isJsonRecord(priorManifest.service)) {
    manifestJson.service = priorManifest.service;
  }
  if (
    previousRelease &&
    previousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = previousRelease;
  } else if (
    priorPreviousRelease &&
    priorPreviousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = priorPreviousRelease;
  }
  manifestJson.updatedAt = nowIso();

  for (const filePath of manifestPaths.writePaths) {
    writeInstallerJson(filePath, manifestJson, writeOptions, deps);
  }
  removeFile(
    legacyManagedFilesPath,
    Boolean(options.elevated),
    deps.runPrivileged,
  );
  return {
    manifestPath,
    locatorManifestPath,
  };
}

export function normalizeInstalledChatSettings(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    runPrivileged: (command: string, args: string[]) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
    captureCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => string;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  const migrations = applyInstallUpgradeMigrations(options, deps);
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeStoredChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
  );
  writeInstallerJson(
    settingsPath,
    settingsJson,
    installerWriteOptions(ownerUser, ownerGroup, options.elevated),
    deps,
  );
  return { settingsPath, migrations };
}

export async function persistInstallerOutputs(
  options: {
    currentUser: string;
    targetUser: string;
    installDir: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    language?: string;
    setDefaultTarget?: boolean;
    chatConfig: any;
    authData: any;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
    managedFiles?: ManagedFilesManifest;
    previousReleaseName?: string;
    previousReleaseRoot?: string;
    elevated?: boolean;
  },
  deps: {
    findSystemUser: (targetUser: string) => any;
    ensureDir: (dir: string) => void;
    readInstallerJson: <T>(
      filePath: string,
      fallback: T,
      elevated?: boolean,
    ) => T;
    writeJsonFileWithPrivilege: (
      filePath: string,
      value: unknown,
      ownerUser?: string,
      ownerGroup?: string | number,
    ) => void;
    writeJsonFile: (filePath: string, value: unknown) => void;
    launcherMetadataPathForUser: (userName: string) => string;
    readJsonFile: <T>(filePath: string, fallback: T) => T;
    writeLaunchersForUser: (
      userName: string,
      installDir: string,
      options?: { elevated?: boolean },
    ) => any;
    reconcileInstallerManifest: typeof reconcileInstallerManifest;
    runPrivileged: (command: string, args: string[]) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
    captureCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => string;
  },
) {
  const { ownerUser, ownerGroup } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  const writeOptions = installerWriteOptions(
    ownerUser,
    ownerGroup,
    options.elevated,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const migrations = applyInstallUpgradeMigrations(options, deps);
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = mergeInstalledChatSettings(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
    options.chatConfig,
  );
  applyInstalledDefaults(settingsJson, options);

  const authPath = installAuthPath(options.installDir);
  const authJson = normalizeInstallerRecord(
    deps.readInstallerJson<any>(authPath, {}, Boolean(options.elevated)),
  );
  const nextAuthJson = {
    ...authJson,
    ...normalizeInstallerRecord(options.authData),
  };

  const launcherPath = deps.launcherMetadataPathForUser(options.currentUser);
  const shouldSetDefaultTarget = options.setDefaultTarget !== false;
  const launcherJson = shouldSetDefaultTarget
    ? normalizeInstallerRecord(deps.readJsonFile<any>(launcherPath, {}))
    : {};
  if (shouldSetDefaultTarget) {
    launcherJson.defaultTargetUser = options.targetUser;
    launcherJson.defaultInstallDir = options.installDir;
  } else {
    delete launcherJson.defaultTargetUser;
    delete launcherJson.defaultInstallDir;
  }
  launcherJson.updatedAt = nowIso();
  launcherJson.installedBy = options.currentUser;

  const { manifestPath, locatorManifestPath } = deps.reconcileInstallerManifest(
    {
      targetUser: options.targetUser,
      installDir: options.installDir,
      release: options.release,
      currentReleaseName: options.currentReleaseName,
      currentReleaseRoot: options.currentReleaseRoot,
      managedFiles: options.managedFiles,
      previousReleaseName: options.previousReleaseName,
      previousReleaseRoot: options.previousReleaseRoot,
      elevated: options.elevated,
    },
    deps,
  );

  writeInstallerJson(settingsPath, settingsJson, writeOptions, deps);
  writeInstallerJson(authPath, nextAuthJson, writeOptions, deps);
  deps.writeJsonFile(launcherPath, launcherJson);
  const currentLaunchers = deps.writeLaunchersForUser(
    options.currentUser,
    options.installDir,
    { elevated: false },
  );
  const targetLaunchers =
    options.targetUser === options.currentUser
      ? currentLaunchers
      : deps.writeLaunchersForUser(options.targetUser, options.installDir, {
          elevated: Boolean(options.elevated),
        });

  return {
    settingsPath,
    authPath,
    launcherPath,
    manifestPath,
    locatorManifestPath,
    migrations,
    ...currentLaunchers,
    currentRinPath: currentLaunchers.rinPath,
    currentRinInstallPath: currentLaunchers.rinInstallPath,
    targetRinPath: targetLaunchers.rinPath,
    targetRinInstallPath: targetLaunchers.rinInstallPath,
  };
}
