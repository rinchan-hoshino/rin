import { register } from "node:module";

const childProcessUrl = `data:text/javascript,${encodeURIComponent(`
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const actual = createRequire(process.cwd() + "/package.json")("node:child_process");
export const execSync = actual.execSync;
export const spawnSync = actual.spawnSync;
export const execFile = actual.execFile;
export const exec = actual.exec;
export function execFileSync(command, args, options) {
  globalThis.__rinSharedOwnerEvents.push(["exec", command, args, options]);
  if (globalThis.__rinSharedOwnerExec) return globalThis.__rinSharedOwnerExec(command, args, options);
  return globalThis.__rinSharedOwnerCaptureValue ?? "owner-capture";
}
export function spawn(command, args, options) {
  globalThis.__rinSharedOwnerEvents.push(["spawn", command, args, options]);
  const child = new EventEmitter();
  child.killed = false;
  child.kill = (signal) => { child.killed = true; globalThis.__rinSharedOwnerEvents.push(["kill", signal]); return true; };
  queueMicrotask(() => {
    const result = globalThis.__rinSharedOwnerSpawnResult || { code: 0, signal: null };
    if (result.error) child.emit("error", result.error);
    else child.emit("exit", result.code ?? null, result.signal ?? null);
  });
  return child;
}
`)}`;

const systemUrl = `data:text/javascript,${encodeURIComponent(`
export function buildUserShell(targetUser, argv, env) {
  globalThis.__rinSharedOwnerEvents.push(["shell", targetUser, argv, env]);
  return { command: "owner-shell", args: argv, env: { ...env, OWNER_TARGET: targetUser } };
}
export function isSameSystemUser(left, right) { return String(left || "") === String(right || ""); }
export function readPasswdUser(user) {
  if (!user || user === "missing") return undefined;
  return { name: user, home: "/home/" + user, uid: user === "rin" ? 1000 : 2000, gid: 2000 };
}
export function socketPathForUser(user) { return "/socket/" + user; }
export function targetUserRuntimeEnv(user, extra) { return { OWNER_RUNTIME_USER: user, ...extra }; }
`)}`;

const clientUrl = `data:text/javascript,${encodeURIComponent(`
export function buildDaemonSocketProbeScript(socketPath, timeoutMs) { return "probe:" + socketPath + ":" + timeoutMs; }
export function buildDaemonStatusScript(socketPath, timeoutMs, id) { return "status:" + socketPath + ":" + timeoutMs + ":" + id; }
export async function canConnectDaemonSocket(socketPath, timeoutMs) {
  globalThis.__rinSharedOwnerEvents.push(["connect", socketPath, timeoutMs]);
  const values = globalThis.__rinSharedOwnerConnectValues || [];
  return values.length ? Boolean(values.shift()) : Boolean(globalThis.__rinSharedOwnerConnect);
}
export async function requestDaemonCommand(command, options) {
  globalThis.__rinSharedOwnerEvents.push(["request", command, options]);
  if (globalThis.__rinSharedOwnerRequestFailure) throw new Error("owner request failed");
  return globalThis.__rinSharedOwnerRequestValue;
}
`)}`;

const commonUrl = `data:text/javascript,${encodeURIComponent(`
export function repoRootFromHere() { return "/repo-owner"; }
export function runCommand(...args) { globalThis.__rinSharedOwnerEvents.push(["run-command", ...args]); }
`)}`;

const privilegedUrl = `data:text/javascript,${encodeURIComponent(`
export function readJsonFileWithPrivilege(filePath, fallback) {
  globalThis.__rinSharedOwnerEvents.push(["privileged-json", filePath, fallback]);
  return globalThis.__rinSharedOwnerPrivilegedValue ?? fallback;
}
`)}`;

const managedUrl = `data:text/javascript,${encodeURIComponent(`
export function tryManagedSystemdAction(units, deps) {
  globalThis.__rinSharedOwnerEvents.push(["systemd", units]);
  if (globalThis.__rinSharedOwnerSystemdUnit) {
    deps.runAction(globalThis.__rinSharedOwnerSystemdUnit);
    return globalThis.__rinSharedOwnerSystemdUnit;
  }
  return null;
}
`)}`;

const updateWorkflowUrl = `data:text/javascript,${encodeURIComponent(`
export function cleanupStaleUpdateWorkDirs() { return []; }
export function requireTool(value) { return value; }
export function runLoggedUpdateCommandSync() { return undefined; }
export function updateWorkRoot() { return "/update-owner"; }
`)}`;

const replacements = {
  "dist/core/rin-lib/system.js": systemUrl,
  "dist/core/rin-daemon/client.js": clientUrl,
  "dist/core/rin-install/common.js": commonUrl,
  "dist/core/rin-install/fs-utils.js": privilegedUrl,
  "dist/core/rin-install/managed-service.js": managedUrl,
  "dist/core/rin-install/update-workflow.js": updateWorkflowUrl,
};

const hookSource = `
const childProcessUrl = ${JSON.stringify(childProcessUrl)};
const replacements = ${JSON.stringify(replacements)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:child_process") return { url: childProcessUrl, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  for (const [target, url] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
globalThis.__rinSharedOwnerEvents ||= [];
