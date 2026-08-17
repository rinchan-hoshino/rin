import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LEGACY_DATA_LAYOUT_MOVES, schedulerDataPath } from "../data-layout.js";
import { isJsonRecord } from "../json-utils.js";
import { stringifyJson } from "../platform/fs.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import { loadFirstValidCandidate } from "./candidate-loader.js";
import {
  concreteGitReleaseRef,
  requireConcreteGitRelease,
  type InstalledReleaseInfo,
} from "../rin-lib/release.js";
import { initStatePath } from "../self-improve/paths.js";
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

function userSkillDir(installDir: string) {
  return path.join(installDir, "self_improve", "skills");
}

function ensureRuntimeUserDirs(
  options: { targetUser: string; installDir: string; elevated?: boolean },
  deps: {
    ensureDir: (dir: string) => void;
    runCommandAsUser?: (
      targetUser: string,
      command: string,
      args: string[],
    ) => void;
  },
) {
  const skillDir = userSkillDir(options.installDir);
  if (options.elevated && deps.runCommandAsUser) {
    deps.runCommandAsUser(options.targetUser, "mkdir", ["-p", skillDir]);
    return;
  }
  deps.ensureDir(skillDir);
}

type InstallPathMoveResult = {
  id: string;
  fromPath: string;
  toPath: string;
  moved: boolean;
  skipped: boolean;
};

type SchemaMigrationCommandDeps = {
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

type SchemaMigrationOptions = {
  targetUser: string;
  elevated?: boolean;
  installDir?: string;
  migrationRuntimeRoot?: string;
  targetNodePath?: string;
  runtimeQuiesced?: boolean;
};

type SchemaMigrationFileOps = {
  pathExists: (filePath: string) => boolean;
  readJsonObject: (filePath: string) => Record<string, unknown> | null;
  writeJsonObject: (filePath: string, value: unknown) => void;
  ensureDir: (dirPath: string) => void;
  rename: (fromPath: string, toPath: string) => void;
  remove: (targetPath: string) => void;
};

function parseJsonObject(text: string) {
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function runMigrationCommandAsTargetUser(
  options: SchemaMigrationOptions,
  deps: SchemaMigrationCommandDeps,
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
  options: SchemaMigrationOptions,
  deps: SchemaMigrationCommandDeps,
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

function createSchemaMigrationFileOps(
  options: SchemaMigrationOptions,
  deps: SchemaMigrationCommandDeps,
): SchemaMigrationFileOps {
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
    remove(targetPath: string) {
      if (elevated) {
        runMigrationCommandAsTargetUser(options, deps, "rm", [
          "-rf",
          targetPath,
        ]);
        return;
      }
      fs.rmSync(targetPath, { recursive: true, force: true });
    },
  };
}

function moveInstalledPathIfNeeded(
  move: {
    id: string;
    fromPath: string;
    toPath: string;
  },
  fileOps: SchemaMigrationFileOps,
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
  fileOps: SchemaMigrationFileOps,
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

function removeInstalledBrowseRuntime(
  installDir: string,
  fileOps: SchemaMigrationFileOps,
) {
  const root = path.resolve(String(installDir || "").trim() || ".");
  const removedPaths: string[] = [];
  for (const targetPath of [
    path.join(root, "data", "sidecars", "browse"),
    path.join(root, "data", "browse"),
  ]) {
    if (!fileOps.pathExists(targetPath)) continue;
    fileOps.remove(targetPath);
    removedPaths.push(targetPath);
  }
  return {
    id: "remove-browse-runtime",
    skipped: removedPaths.length === 0,
    removedPaths,
  };
}

function runMemorySchemaMigration(
  options: SchemaMigrationOptions & { installDir: string },
  deps: SchemaMigrationCommandDeps,
  mode: "preflight" | "apply" | "finalize" | "rollback",
) {
  const runtimeRoot = safeString(options.migrationRuntimeRoot).trim();
  if (!runtimeRoot) {
    const transcriptDbPath = path.join(
      path.resolve(options.installDir),
      "memory",
      "search.db",
    );
    if (
      fs.existsSync(transcriptDbPath) ||
      fs.existsSync(`${transcriptDbPath}.schema.json`)
    ) {
      throw new Error("memory_install_migration_runtime_required");
    }
    return null;
  }
  const runnerPath = path.join(
    runtimeRoot,
    "dist",
    "app",
    "rin-install",
    "memory-migrations.js",
  );
  const args = [
    runnerPath,
    ...(mode === "apply"
      ? ["--apply", ...(options.runtimeQuiesced ? ["--runtime-quiesced"] : [])]
      : [`--${mode}`]),
    path.resolve(options.installDir),
  ];
  const nodePath =
    safeString(options.targetNodePath).trim() || process.execPath;
  if (options.elevated) {
    runMigrationCommandAsTargetUser(options, deps, nodePath, args);
  } else {
    execFileSync(nodePath, args, { stdio: "pipe" });
  }
  return {
    id:
      mode === "apply"
        ? "transcript-search-schema-v6"
        : `transcript-search-schema-v6-${mode}`,
    skipped: false,
    executedAs: options.targetUser,
  };
}

export function preflightInstallUpgradeMigrations(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
    migrationRuntimeRoot?: string;
    targetNodePath?: string;
  },
  deps: SchemaMigrationCommandDeps,
) {
  const migration = runMemorySchemaMigration(options, deps, "preflight");
  return migration ? [migration] : [];
}

export function applyInstallUpgradeMigrations(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
    migrationRuntimeRoot?: string;
    targetNodePath?: string;
    runtimeQuiesced?: boolean;
  },
  deps: SchemaMigrationCommandDeps,
) {
  const fileOps = createSchemaMigrationFileOps(options, deps);
  return [
    migrateInstalledDataLayout(options.installDir, fileOps),
    removeInstalledBrowseRuntime(options.installDir, fileOps),
    runMemorySchemaMigration(options, deps, "apply"),
  ].filter(Boolean);
}

export function finalizeInstallUpgradeMigrations(
  options: SchemaMigrationOptions & { installDir: string },
  deps: SchemaMigrationCommandDeps,
) {
  return runMemorySchemaMigration(options, deps, "finalize");
}

export function rollbackInstallUpgradeMigrations(
  options: SchemaMigrationOptions & { installDir: string },
  deps: SchemaMigrationCommandDeps,
) {
  return runMemorySchemaMigration(options, deps, "rollback");
}

function normalizeInstallerRecord(value: unknown) {
  return isJsonRecord(value) ? value : {};
}

function normalizeSettingsForMigration(value: unknown) {
  const settings = isJsonRecord(value) ? { ...value } : {};
  delete settings.language;
  return settings;
}

function applyInstalledDefaults(
  target: any,
  options: {
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
  },
) {
  if (options.provider) target.defaultProvider = options.provider;
  if (options.modelId) target.defaultModel = options.modelId;
  if (options.thinkingLevel) {
    target.defaultThinkingLevel = options.thinkingLevel;
  }
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

function isGitHash(value: string) {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
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
  const rawRef = String(release.ref || "").trim();
  const sourceLabel = String(release.sourceLabel || "").trim();
  const archiveUrl = String(release.archiveUrl || "").trim();
  const installedAt = String(release.installedAt || "").trim();
  if (!version && !branch && !rawRef && !sourceLabel && !archiveUrl)
    return undefined;
  if (normalizedChannel === "git") {
    const concreteRef = isGitHash(rawRef)
      ? rawRef
      : isGitHash(version)
        ? version
        : "";
    return {
      channel: normalizedChannel,
      version: concreteRef ? concreteRef.slice(0, 12) : "unknown",
      branch: branch || "main",
      ref: concreteRef,
      sourceLabel: sourceLabel || `git ${branch || "main"}`,
      archiveUrl,
      installedAt: installedAt || undefined,
    };
  }
  return {
    channel: normalizedChannel,
    version: version || "unknown",
    branch: branch || (normalizedChannel === "stable" ? "stable" : "main"),
    ref: rawRef || version || "main",
    sourceLabel:
      sourceLabel || `${normalizedChannel} ${version || rawRef || "unknown"}`,
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

function isUsableRollbackReleaseRecord(
  record: ReturnType<typeof buildInstalledReleaseRecord>,
) {
  if (!record || record.name.toLowerCase() === "unknown") return false;
  if (!record.release) return true;
  if (record.release.channel === "git") {
    return Boolean(concreteGitReleaseRef(record.release));
  }
  return record.release.version !== "unknown";
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
  if (options.release) requireConcreteGitRelease(options.release);
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
  const previousReleaseCandidate = buildInstalledReleaseRecord({
    name: options.previousReleaseName,
    root: options.previousReleaseRoot,
    release: previousReleaseMetadata,
  });
  const previousRelease = isUsableRollbackReleaseRecord(
    previousReleaseCandidate,
  )
    ? previousReleaseCandidate
    : undefined;
  const fallbackPreviousRelease = isUsableRollbackReleaseRecord(
    priorPreviousRelease,
  )
    ? priorPreviousRelease
    : undefined;
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
    fallbackPreviousRelease &&
    fallbackPreviousRelease.name !== String(currentRelease?.name || "")
  ) {
    manifestJson.previousRelease = fallbackPreviousRelease;
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

export function normalizeInstalledSettings(
  options: {
    targetUser: string;
    installDir: string;
    elevated?: boolean;
    currentReleaseRoot?: string;
    migrationRuntimeRoot?: string;
    targetNodePath?: string;
    runtimeQuiesced?: boolean;
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
  const migrations = applyInstallUpgradeMigrations(
    {
      ...options,
      migrationRuntimeRoot:
        options.migrationRuntimeRoot || options.currentReleaseRoot,
    },
    deps,
  );
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeSettingsForMigration(
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
    setDefaultTarget?: boolean;
    authData: any;
    release?: InstalledReleaseInfo;
    currentReleaseName?: string;
    currentReleaseRoot?: string;
    migrationRuntimeRoot?: string;
    targetNodePath?: string;
    runtimeQuiesced?: boolean;
    managedFiles?: ManagedFilesManifest;
    previousReleaseName?: string;
    previousReleaseRoot?: string;
    elevated?: boolean;
    initializationComplete?: boolean;
    writeLaunchers?: boolean;
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
  ensureRuntimeUserDirs(options, deps);

  const migrations = applyInstallUpgradeMigrations(
    {
      ...options,
      migrationRuntimeRoot:
        options.migrationRuntimeRoot || options.currentReleaseRoot,
    },
    deps,
  );
  const settingsPath = installSettingsPath(options.installDir);
  const settingsJson = normalizeSettingsForMigration(
    deps.readInstallerJson<any>(settingsPath, {}, Boolean(options.elevated)),
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
  const initializationComplete = options.initializationComplete !== false;
  const initStateJson = {
    version: 2,
    promptedAt: "",
    completedAt: initializationComplete ? nowIso() : "",
    lastTrigger: initializationComplete ? "install_existing" : "install_fresh",
    pending: false,
    initialized: initializationComplete,
  };

  const writeLaunchers = options.writeLaunchers !== false;
  const launcherPath = writeLaunchers
    ? deps.launcherMetadataPathForUser(options.currentUser)
    : "";
  const shouldSetDefaultTarget = options.setDefaultTarget !== false;
  const launcherJson = writeLaunchers
    ? shouldSetDefaultTarget
      ? normalizeInstallerRecord(deps.readJsonFile<any>(launcherPath, {}))
      : {}
    : {};
  if (writeLaunchers) {
    if (shouldSetDefaultTarget) {
      launcherJson.defaultTargetUser = options.targetUser;
      launcherJson.defaultInstallDir = options.installDir;
    } else {
      delete launcherJson.defaultTargetUser;
      delete launcherJson.defaultInstallDir;
    }
    launcherJson.updatedAt = nowIso();
    launcherJson.installedBy = options.currentUser;
  }

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

  const initStateFilePath = initStatePath(options.installDir);
  writeInstallerJson(settingsPath, settingsJson, writeOptions, deps);
  writeInstallerJson(authPath, nextAuthJson, writeOptions, deps);
  writeInstallerJson(initStateFilePath, initStateJson, writeOptions, deps);
  if (!writeLaunchers) {
    return {
      settingsPath,
      authPath,
      initStatePath: initStateFilePath,
      manifestPath,
      locatorManifestPath,
      migrations,
    };
  }

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
    initStatePath: initStateFilePath,
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
