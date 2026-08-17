import "./require-test-sandbox.ts";
import { register } from "node:module";

const replacements = {
  "dist/core/platform/process.js": `export async function sleep(ms){globalThis.__rinManagedOwnerEvents.push(["sleep",ms])}`,
  "dist/core/rin-daemon/client.js": `export async function canConnectDaemonSocket(path,timeout){globalThis.__rinManagedOwnerEvents.push(["connect",path,timeout]); return false}`,
  "dist/core/rin-daemon/lock.js": `export function readDaemonInstanceLockOwner(agentDir){globalThis.__rinManagedOwnerEvents.push(["lock",agentDir]); return {pid:globalThis.__rinManagedOwnerPid || 0}}`,
  "dist/core/rin-lib/common.js": `export function bridgeDaemonSocketPath(dir){return dir+"/bridge.sock"}`,
  "dist/core/rin-lib/runtime.js": `export const RIN_DIR_ENV="RIN_DIR"`,
  "dist/core/rin-lib/system.js": `
    export function isSameSystemUser(a,b){return String(a||"")===String(b||"")}
    export function socketPathForUser(user){return "/runtime/"+user+".sock"}
    export function targetUserRuntimeEnv(user,extra){return {...extra,OWNER_TARGET_USER:user}}
    export function buildUserShell(user,argv,env){return {command:argv[0],args:argv.slice(1),env}}
  `,
  "dist/core/rin-install/managed-service.js": `
    export function tryManagedSystemdAction(candidates,actions){
      globalThis.__rinManagedOwnerEvents.push(["systemd-candidates",candidates]);
      actions.daemonReload();
      actions.runAction(candidates[0]);
      return globalThis.__rinManagedOwnerSystemdFails ? "" : candidates[0];
    }
  `,
  "dist/core/rin-install/service.js": `export function startWindowsDaemonProcess(user,dir){globalThis.__rinManagedOwnerEvents.push(["windows-start",user,dir])}`,
  "dist/core/rin-install/paths.js": `export function defaultInstallDirForHome(home){return home+"/.rin"}`,
  "dist/core/rin-install/users.js": `export function findSystemUser(user){return user==="missing"?undefined:{name:user,home:"/home/"+user,uid:501}} export function targetHomeForUser(user){return "/home/"+user}`,
  "dist/core/rin/shared.js": `
    export function readInstallerManifestForTarget(installDir,options){return options.readJson ? options.readJson(installDir+"/installer.json",{}) : globalThis.__rinManagedOwnerManifest || {}}
    export function resolveRuntimeAgentDirForTarget(user,current,installDir){return installDir+"/agent"}
    export function targetPathExists(context,filePath){globalThis.__rinManagedOwnerEvents.push(["path",filePath]); return globalThis.__rinManagedOwnerPathExists !== false}
  `,
};
const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements=${JSON.stringify(replacementUrls)};
export async function resolve(specifier,context,nextResolve){
 const resolved=await nextResolve(specifier,context);
 for(const [target,url] of Object.entries(replacements)) if(resolved.url.endsWith(target)) return {url,shortCircuit:true};
 return resolved;
}`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
