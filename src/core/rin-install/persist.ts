import fs from "node:fs";
import path from "node:path";

import { normalizeStoredChatSettings } from "../chat/settings.js";
import {
  listChatStateFiles,
  listDetachedControllerStateFiles,
} from "../chat/support.js";
import { isJsonRecord } from "../json-utils.js";
import { normalizeLanguageTag } from "../language.js";
import { stringifyJson } from "../platform/fs.js";
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

const PREVIOUS_CHAT_MESSAGE_STORE_DIRNAME = "koishi-message-store";
const CHAT_MESSAGE_STORE_DIRNAME = "chat-message-store";

type InstallPathMoveResult = {
  id: string;
  fromPath: string;
  toPath: string;
  moved: boolean;
  skipped: boolean;
};

function installerPathExists(
  filePath: string,
  elevated: boolean,
  runPrivileged: (command: string, args: string[]) => void,
) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch (error: any) {
    const code = String(error?.code || "");
    if ((code === "EACCES" || code === "EPERM") && elevated) {
      try {
        runPrivileged("test", ["-e", filePath]);
        return true;
      } catch {}
    }
    return false;
  }
}

function moveInstalledPathIfNeeded(
  move: {
    id: string;
    fromPath: string;
    toPath: string;
  },
  options: {
    elevated?: boolean;
  },
  deps: {
    runPrivileged: (command: string, args: string[]) => void;
  },
): InstallPathMoveResult {
  const elevated = Boolean(options.elevated);
  const hasSource = installerPathExists(
    move.fromPath,
    elevated,
    deps.runPrivileged,
  );
  if (!hasSource) {
    return { ...move, moved: false, skipped: false };
  }
  const hasTarget = installerPathExists(
    move.toPath,
    elevated,
    deps.runPrivileged,
  );
  if (hasTarget) {
    return { ...move, moved: false, skipped: true };
  }
  const parentDir = path.dirname(move.toPath);
  if (elevated) {
    deps.runPrivileged("mkdir", ["-p", parentDir]);
    deps.runPrivileged("mv", [move.fromPath, move.toPath]);
  } else {
    fs.mkdirSync(parentDir, { recursive: true });
    fs.renameSync(move.fromPath, move.toPath);
  }
  return { ...move, moved: true, skipped: false };
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

function readJsonObject(filePath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function writeJsonObject(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyJson(value), "utf8");
}

function rewriteChatStateSessionFileKey(statePath: string) {
  const state = readJsonObject(statePath);
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
  writeJsonObject(statePath, nextState);
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
): InstallStateRewriteResult {
  const markerPath = chatStateSessionFileMigrationMarkerPath(installDir);
  const marker = readJsonObject(markerPath);
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
    ...listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
    ...listDetachedControllerStateFiles(
      path.join(root, "data", "cron-turns"),
    ).map((item) => item.statePath),
  ]);
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    if (!rewriteChatStateSessionFileKey(statePath)) continue;
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

  writeJsonObject(markerPath, {
    id: CHAT_STATE_SESSION_FILE_MIGRATION_ID,
    appliedAt: new Date().toISOString(),
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
) {
  const parsed = path.parse(basename);
  let candidate = path.join(managedDir, basename);
  let index = 2;
  while (fs.existsSync(candidate)) {
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
) {
  const state = readJsonObject(statePath);
  if (!state) return "";
  const sessionFile = safeString(state.sessionFile).trim();
  if (!sessionFile || sessionFile.startsWith("managed/")) return "";
  const source = sessionFilePathForInstalledChatState(installDir, sessionFile);
  if (!source) return "";

  const managedDir = getManagedChatSessionDir(installDir);
  const targetPath = pickAvailableManagedChatSessionPath(
    managedDir,
    source.basename,
  );
  if (!fs.existsSync(source.absolute)) return "";
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.renameSync(source.absolute, targetPath);

  const nextState: Record<string, unknown> = { ...state };
  nextState.sessionFile = path.relative(source.sessionsDir, targetPath);
  writeJsonObject(statePath, nextState);
  return targetPath;
}

function migrateInstalledChatSessionFilesToManaged(
  installDir: string,
): InstallStateRewriteResult {
  const markerPath = chatSessionManagedFileMigrationMarkerPath(installDir);
  const marker = readJsonObject(markerPath);
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
  const statePaths = uniqueStatePaths(
    listChatStateFiles(path.join(root, "data", "chats")).map(
      (item) => item.statePath,
    ),
  );
  const migratedFiles: string[] = [];
  for (const statePath of statePaths) {
    const migratedFile = migrateChatStateSessionFileToManaged(root, statePath);
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

  writeJsonObject(markerPath, {
    id: CHAT_SESSION_MANAGED_FILE_MIGRATION_ID,
    appliedAt: new Date().toISOString(),
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
    installDir: string;
    elevated?: boolean;
  },
  deps: {
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  return [
    moveInstalledPathIfNeeded(
      {
        id: "chat-message-store-dir",
        fromPath: path.join(
          options.installDir,
          "data",
          PREVIOUS_CHAT_MESSAGE_STORE_DIRNAME,
        ),
        toPath: path.join(
          options.installDir,
          "data",
          CHAT_MESSAGE_STORE_DIRNAME,
        ),
      },
      options,
      deps,
    ),
    rewriteInstalledChatStateSessionFileKeys(options.installDir),
    migrateInstalledChatSessionFilesToManaged(options.installDir),
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
    ? normalizeLanguageTag(normalizedLanguage, "en")
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
  return language;
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

function normalizeInstalledManifest(manifestJson: any, chatConfig?: any) {
  const normalized = normalizeStoredChatSettings(manifestJson);
  const normalizedChatConfig = normalizeChatConfigRoot(chatConfig);
  if (normalizedChatConfig) normalized.chat = normalizedChatConfig;
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
    channel === "beta" || channel === "git" ? channel : "stable";
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

export function reconcileInstallerManifest(
  options: {
    targetUser: string;
    installDir: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    language?: string;
    chatConfig?: any;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
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
    runPrivileged: (command: string, args: string[]) => void;
  },
) {
  const { ownerUser, ownerGroup, ownerHome } = resolveInstallOwner(
    options.targetUser,
    deps.findSystemUser,
  );
  if (!options.elevated) deps.ensureDir(options.installDir);

  const manifestPaths = installerManifestPaths(options.installDir, ownerHome);
  const {
    manifestPath,
    locatorManifestPath,
    legacyManifestPath,
    legacyLocatorManifestPath,
  } = manifestPaths;
  const writeOptions = installerWriteOptions(
    ownerUser,
    ownerGroup,
    options.elevated,
  );
  const manifestJson: any = normalizeInstalledManifest(
    loadFirstValidCandidate(
      manifestPaths.recoveryPaths,
      (filePath) =>
        deps.readInstallerJson<any>(filePath, null, Boolean(options.elevated)),
      (value) => (isJsonRecord(value) ? value : null),
    ) || {},
    options.chatConfig,
  );
  manifestJson.targetUser = options.targetUser;
  manifestJson.installDir = options.installDir;
  applyInstalledDefaults(manifestJson, options);
  const normalizedRelease = normalizeInstalledReleaseInfo(options.release);
  const priorCurrentRelease = isInstalledReleaseRecord(
    manifestJson.currentRelease,
  )
    ? manifestJson.currentRelease
    : undefined;
  const priorPreviousRelease = isInstalledReleaseRecord(
    manifestJson.previousRelease,
  )
    ? manifestJson.previousRelease
    : undefined;
  const previousReleaseName = String(options.previousReleaseName || "").trim();
  const previousReleaseMetadata = previousReleaseName
    ? priorCurrentRelease?.name === previousReleaseName
      ? priorCurrentRelease.release
      : priorPreviousRelease?.name === previousReleaseName
        ? priorPreviousRelease.release
        : manifestJson.release
    : undefined;
  const previousRelease = buildInstalledReleaseRecord({
    name: options.previousReleaseName,
    root: options.previousReleaseRoot,
    release: previousReleaseMetadata,
  });
  const currentRelease = buildInstalledReleaseRecord({
    name: options.currentReleaseName,
    root: options.currentReleaseRoot,
    release: normalizedRelease,
  });
  if (normalizedRelease) {
    manifestJson.release = {
      channel: normalizedRelease.channel,
      version: normalizedRelease.version,
      branch: normalizedRelease.branch,
      ref: normalizedRelease.ref,
      sourceLabel: normalizedRelease.sourceLabel,
      archiveUrl: normalizedRelease.archiveUrl,
      installedAt: normalizedRelease.installedAt || new Date().toISOString(),
    };
  }
  if (currentRelease) manifestJson.currentRelease = currentRelease;
  if (
    previousRelease &&
    previousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = previousRelease;
  } else if (!currentRelease && priorCurrentRelease) {
    manifestJson.currentRelease = priorCurrentRelease;
  }
  manifestJson.updatedAt = new Date().toISOString();

  for (const filePath of manifestPaths.writePaths) {
    writeInstallerJson(filePath, manifestJson, writeOptions, deps);
  }
  for (const filePath of manifestPaths.cleanupPaths) {
    removeFile(filePath, Boolean(options.elevated), deps.runPrivileged);
  }

  return {
    manifestPath,
    locatorManifestPath,
    legacyManifestPath,
    legacyLocatorManifestPath,
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
  const language = applyInstalledDefaults(settingsJson, options);

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
  launcherJson.updatedAt = new Date().toISOString();
  launcherJson.installedBy = options.currentUser;

  const { manifestPath, locatorManifestPath } = deps.reconcileInstallerManifest(
    {
      targetUser: options.targetUser,
      installDir: options.installDir,
      provider: options.provider,
      modelId: options.modelId,
      thinkingLevel: options.thinkingLevel,
      language,
      chatConfig: normalizeChatConfigRoot(options.chatConfig) || {},
      release: options.release,
      currentReleaseName: options.currentReleaseName,
      currentReleaseRoot: options.currentReleaseRoot,
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
