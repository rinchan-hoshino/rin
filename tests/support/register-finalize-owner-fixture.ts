import { register } from "node:module";

const target = "dist/core/rin-install/finalize.js";
const sources: Record<string, string> = {
  "dist/core/rin-install/fs-utils.js": `
    import path from "node:path";
    const event = (...value) => globalThis.__rinFinalizeEvents.push(value);
    export function launcherMetadataPathForUser(user, homeForUser) { return path.join(homeForUser(user), ".config/rin/launcher.json"); }
    export function currentInstalledReleaseName(dir, elevated) { event("current-release", dir, elevated); return globalThis.__rinFinalizeScenario.previousReleaseName || ""; }
    export function discardStagedInstalledRuntime(...args) { event("discard-staged", ...args); }
    export function ensureDir(dir) { event("ensure", dir); }
    export function publishInstalledRuntime(sourceRoot, installDir, user, elevated, options) { event("publish", sourceRoot, installDir, user, elevated, options); return globalThis.__rinFinalizeScenario.publishedRuntime || { releaseRoot: path.join(installDir, "app/releases/owner-release"), currentLink: path.join(installDir, "app/current") }; }
    export function activateInstalledRuntimeReplacement(installDir, releaseRoot, user, elevated) { event("activate", installDir, releaseRoot, user, elevated); return { backupReleaseRoot: releaseRoot + ".backup" }; }
    export function commitInstalledRuntimeReplacement(installDir, activation, user, elevated) { event("commit", installDir, activation, user, elevated); }
    export function rollbackInstalledRuntimeReplacement(installDir, activation, user, elevated) { event("rollback", installDir, activation, user, elevated); }
    export function publishManagedNodeRuntime(sourceRoot, installDir, user, elevated, options) { event("managed-node", sourceRoot, installDir, user, elevated, options); return { nodeExecutable: path.join(installDir, "runtime/node/current/bin/node") }; }
    export function pruneInstalledReleases(...args) { event("prune", ...args); return ["old-release"]; }
    export function readInstallerJson(file, fallback) { event("read-installer", file); return fallback; }
    export function readJsonFile(file, fallback) { event("read-json", file); return globalThis.__rinFinalizeScenario.launcherMetadata ?? fallback; }
    export function runCommandAsUser(...args) { event("as-user", ...args); }
    export function runPrivileged(...args) { event("privileged", ...args); }
    export function captureCommandAsUser(...args) { event("capture-user", ...args); return ""; }
    export function buildInstalledManagedFilesManifest(sourceRoot) { event("managed-files", sourceRoot); return ["dist/owner.js"]; }
    export function syncInstalledDocs(sourceRoot, installDir, user, elevated) { event("docs", sourceRoot, installDir, user, elevated); return { rin: path.join(installDir, "docs/rin"), pi: [path.join(installDir, "docs/pi")] }; }
    export function switchInstalledCurrentRelease(...args) { event("switch-current", ...args); }
    export function writeJsonFile(...args) { event("write-json", ...args); }
    export function writeJsonFileWithPrivilege(...args) { event("write-json-elevated", ...args); }
    export function writeLaunchersForUser(user, installDir, homeForUser, options) { event("launcher", user, installDir, options); return { rinPath: path.join(homeForUser(user), ".local/bin/rin"), rinInstallPath: path.join(homeForUser(user), ".local/bin/rin-install") }; }
  `,
  "dist/core/rin-install/execution-context.js": `
    export function createInstallExecutionContext(options) { globalThis.__rinFinalizeEvents.push(["execution-context", options]); return { ...options, targetNodePath: options.targetNodePath || "/owner/node" }; }
  `,
  "dist/core/rin-install/paths.js": `
    import path from "node:path";
    export function defaultInstallDirForHome(home) { return path.join(home, ".rin"); }
    export function installedReleaseRoot(dir, name) { return path.join(dir, "app/releases", name); }
  `,
  "dist/core/rin-install/persist.js": `
    export function normalizeInstalledChatSettings(options) { globalThis.__rinFinalizeEvents.push(["normalize", options]); return { mode: "normalized", options }; }
    export function preflightInstallUpgradeMigrations(options, deps) { globalThis.__rinFinalizeEvents.push(["preflight-migrations", options, deps]); }
    export function finalizeInstallUpgradeMigrations(options, deps) { globalThis.__rinFinalizeEvents.push(["finalize-migrations", options, deps]); }
    export function rollbackInstallUpgradeMigrations(options, deps) { globalThis.__rinFinalizeEvents.push(["rollback-migrations", options, deps]); }
    export async function persistInstallerOutputs(options, deps) {
      globalThis.__rinFinalizeEvents.push(["persist", options]);
      deps.launcherMetadataPathForUser(options.targetUser);
      if (options.writeLaunchers) deps.writeLaunchersForUser(options.targetUser, options.installDir, {});
      return { mode: "persisted", options };
    }
    export function reconcileInstallerManifest(options) { globalThis.__rinFinalizeEvents.push(["manifest", options]); return { mode: "manifest", options }; }
  `,
  "dist/core/rin-install/service.js": `
    import path from "node:path";
    export function collectDaemonFailureDetails(user, dir) { globalThis.__rinFinalizeEvents.push(["failure-details", user, dir]); return "owner daemon details"; }
    export function daemonSocketPathForUser() { return globalThis.__rinFinalizeScenario.socketPath; }
    export function buildSystemdUserService(user, dir) { if (globalThis.__rinFinalizeScenario.noStageService) return null; return { kind: "systemd", label: "rin-" + user + ".service", servicePath: path.join(dir, "service") }; }
    export function installDaemonService(user, dir, elevated, deps, options) { globalThis.__rinFinalizeEvents.push(["install-service", user, dir, elevated, options]); if (globalThis.__rinFinalizeScenario.installServiceError) throw new Error("owner service install failed"); return globalThis.__rinFinalizeScenario.installedService === undefined ? { kind: "systemd", label: "rin-" + user + ".service", servicePath: path.join(dir, "service") } : globalThis.__rinFinalizeScenario.installedService; }
    export function refreshManagedServiceFiles(user, dir, elevated) { globalThis.__rinFinalizeEvents.push(["refresh-service", user, dir, elevated]); }
    export async function waitForSocket(socket, timeout, user, options) { globalThis.__rinFinalizeEvents.push(["wait-socket", socket, timeout, user, options]); return globalThis.__rinFinalizeScenario.daemonReady !== false; }
  `,
  "dist/core/rin-install/common.js": `
    export function detectCurrentUser() { return globalThis.__rinFinalizeScenario.currentUser || "owner"; }
    export function repoRootFromHere() { return globalThis.__rinFinalizeScenario.sourceRoot; }
  `,
  "dist/core/rin-install/daemon-update-fence.js": `
    async function acquire(kind, options) {
      globalThis.__rinFinalizeEvents.push(["acquire-fence", kind, options]);
      return {
        async release() {
          globalThis.__rinFinalizeEvents.push(["release-fence", kind]);
        },
      };
    }
    export async function acquireTargetDaemonMigrationLock(options) { return await acquire("migration", options); }
    export async function acquireTargetDaemonUpdateFence(options) { return await acquire("update", options); }
  `,
  "dist/core/rin-lib/release.js": `
    export function buildGitHubRefArchiveUrl(repo, ref) { return repo.replace(/\\.git$/, "") + "/archive/" + ref + ".tar.gz"; }
  `,
  "dist/core/rin/managed-runtime-service.js": `
    export function createManagedRuntimeServiceActionContext(options) { globalThis.__rinFinalizeEvents.push(["service-context", options]); return { ...options, agentDir: globalThis.__rinFinalizeScenario.agentDir, async canConnectSocket() { return globalThis.__rinFinalizeScenario.socketConnectable === undefined ? globalThis.__rinFinalizeScenario.daemonReady !== false : globalThis.__rinFinalizeScenario.socketConnectable; } }; }
    export async function setManagedServiceStartHold(context, held, service) { globalThis.__rinFinalizeEvents.push(["service-hold", held, service]); }
    export async function tryManagedServiceAction(context, action, service) { globalThis.__rinFinalizeEvents.push(["service-action", action, service]); if (globalThis.__rinFinalizeScenario.serviceActionError) throw new Error("owner service action failed"); if (action === "stop") globalThis.__rinFinalizeScenario.socketConnectable = false; if (action === "start" || action === "restart") globalThis.__rinFinalizeScenario.socketConnectable = globalThis.__rinFinalizeScenario.daemonReady !== false; return true; }
  `,
  "dist/core/rin-install/users.js": `
    export function describeOwnership(user, dir) { globalThis.__rinFinalizeEvents.push(["ownership", user, dir]); return globalThis.__rinFinalizeScenario.ownership || { ownerMatches: true, writable: true }; }
    export function findSystemUser(user) { return { name: user, uid: 1001, gid: 1001, home: "/homes/" + user }; }
    export function homeForUser(user) { return "/homes/" + user; }
    export function isSameSystemUser(left, right) { return String(left) === String(right); }
    export function shouldUseElevatedWrite(user, ownership, current) { return Boolean(globalThis.__rinFinalizeScenario.elevatedWrite); }
    export function targetHomeForUser(user) { return "/homes/" + user; }
  `,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.endsWith(target)) for(const [key,url] of Object.entries(urls)) if(resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

globalThis.__rinFinalizeEvents ||= [];
globalThis.__rinFinalizeScenario ||= {};
