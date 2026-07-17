import { register } from "node:module";

const target = "dist/core/rin-install/service.js";
const sources: Record<string, string> = {
  "node:os": `
    export default { userInfo() { if (globalThis.__rinServiceScenario.userInfoError) throw new Error("owner user info"); return { username: globalThis.__rinServiceScenario.currentUser || "owner" }; } };
  `,
  "node:child_process": `
    import { EventEmitter } from "node:events";
    export function execFileSync(command, args, options) {
      globalThis.__rinServiceEvents.push(["exec", command, args, options]);
      const scenario = globalThis.__rinServiceScenario;
      if (scenario.execError) throw new Error("owner exec failed");
      if (String(command).includes("journalctl")) return scenario.journal || "owner journal";
      if (String(args).includes("status")) return scenario.status || "owner status";
      return "";
    }
    export function spawn(command, args, options) {
      globalThis.__rinServiceEvents.push(["spawn", command, args, options]);
      const child = new EventEmitter();
      child.unref = () => globalThis.__rinServiceEvents.push(["unref"]);
      return child;
    }
  `,
  "dist/core/rin-install/fs-utils.js": `
    import fs from "node:fs";
    import path from "node:path";
    const event = (...value) => globalThis.__rinServiceEvents.push(value);
    export function captureCommandAsUser(user, command, args, env) { event("capture-user", user, command, args, env); if (globalThis.__rinServiceScenario.captureError) throw new Error("owner capture failed"); return globalThis.__rinServiceScenario.captureResult || "owner capture"; }
    export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
    export function installedRuntimeNodeCommandArgs({ installDir, platform = process.platform }) { return [path.join(installDir, "runtime/node/current", platform === "win32" ? "node.exe" : "bin/node")]; }
    export function installedRuntimeNodePathDirs({ installDir, platform = process.platform }) { return [path.dirname(installedRuntimeNodeCommandArgs({ installDir, platform })[0])]; }
    export function installedRuntimePathValue(home, dirs) { return [...dirs, path.join(home, ".local/bin"), "/usr/bin"].join(path.delimiter); }
    export function runCommandAsUser(...args) { event("as-user", ...args); if (globalThis.__rinServiceScenario.asUserError) throw new Error("owner as-user failed"); }
    export function runPrivileged(...args) { event("privileged", ...args); if (globalThis.__rinServiceScenario.privilegedError) throw new Error("owner privileged failed"); }
    export function writeTextFile(file, value, mode = 0o644) { event("write", file, mode); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); fs.chmodSync(file, mode); }
    export function writeTextFileWithPrivilege(file, value, user, group, mode = 0o644) { event("write-elevated", file, user, group, mode); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { mode }); fs.chmodSync(file, mode); }
  `,
  "dist/core/platform/process.js": `
    export async function sleep(ms) { globalThis.__rinServiceEvents.push(["sleep", ms]); }
  `,
  "dist/core/rin-daemon/client.js": `
    export function buildDaemonSocketProbeScript(socket, timeout) { return "probe:" + socket + ":" + timeout; }
    export async function canConnectDaemonSocket(socket, timeout) { globalThis.__rinServiceEvents.push(["connect", socket, timeout]); return globalThis.__rinServiceScenario.connect === true; }
  `,
  "dist/core/rin-install/users.js": `
    export function isSameSystemUser(left, right) { return String(left || "") === String(right || ""); }
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
const ownsParent=(parentURL)=>parentURL?.includes(target);
export async function resolve(specifier,context,nextResolve){
 if(ownsParent(context.parentURL) && urls[specifier]) return {url:urls[specifier],shortCircuit:true};
 const resolved=await nextResolve(specifier,context);
 if(ownsParent(context.parentURL)) for(const [key,url] of Object.entries(urls)) if(!key.startsWith("node:") && resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
if (process.env.RIN_DISABLE_SERVICE_OWNER_LOADER !== "1") {
  register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
}

globalThis.__rinServiceEvents ||= [];
globalThis.__rinServiceScenario ||= {};
