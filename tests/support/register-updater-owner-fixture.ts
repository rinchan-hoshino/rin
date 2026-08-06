import { register } from "node:module";

const replacements = {
  "@clack/prompts": `
    export function intro(value){globalThis.__rinUpdaterOwnerEvents.push(["intro",value])}
    export function outro(value){globalThis.__rinUpdaterOwnerEvents.push(["outro",value])}
    export async function select(options){globalThis.__rinUpdaterOwnerEvents.push(["select",options]);return globalThis.__rinUpdaterOwnerSelection ?? 0}
    export async function confirm(options){globalThis.__rinUpdaterOwnerEvents.push(["confirm",options]);return globalThis.__rinUpdaterOwnerConfirm !== false}
  `,
  "dist/core/rin-lib/release.js": `
    export function getReleaseRepoUrl(){globalThis.__rinUpdaterOwnerEvents.push(["repo-url"]);return "https://example.test/rin.git"}
    export async function loadReleaseManifestForNetwork(){globalThis.__rinUpdaterOwnerEvents.push(["manifest"]);return globalThis.__rinUpdaterOwnerManifestWithoutRepo ? {} : {git:{repoUrl:"https://example.test/manifest.git"}}}
    export function resolveReleaseRequest(manifest,request){globalThis.__rinUpdaterOwnerEvents.push(["request",request]);return {...request,sourceLabel:"requested"}}
    export function concreteGitReleaseRef(release){return release?.ref || release?.commit || release?.branch || ""}
    export function requireConcreteGitRelease(release){const ref=concreteGitReleaseRef(release);if(!ref)throw new Error("rin_git_ref_not_resolved");return {...release,ref}}
  `,
  "dist/core/rin-install/update-targets.js": `export function discoverInstalledTargets(){return globalThis.__rinUpdaterOwnerTargets || []}`,
  "dist/core/rin-install/apply-plan.js": `export async function runFinalizeInstallPlanInChild(){throw new Error("owner_finalize_dependency_required")}`,
  "dist/core/rin-install/interactive.js": `
    export function wrapInstallerNoteText(value,width){return "["+width+"] "+String(value||"")}
    export function renderInstallerNote(body,title){return (title?title+"\\n":"")+body}
  `,
  "dist/core/rin-install/progress.js": `export async function runInstallerProgress(message,action,options){globalThis.__rinUpdaterOwnerEvents.push(["progress",message,options]);return await action()}`,
  "dist/core/rin-install/update-workflow.js": `
    import fs from "node:fs";
    import path from "node:path";
    export function preparedRuntimeNodeExecutable(root){return path.join(root,"runtime","node","current","bin","node")}
    export function provisionPreparedCurrentNodeRuntime(root){return {nodeExecutable:preparedRuntimeNodeExecutable(root),npmCli:path.join(root,"runtime","node","current","lib","node_modules","npm","bin","npm-cli.js")}}
    export function isInstalledReleaseCurrent(installed,resolved){globalThis.__rinUpdaterOwnerEvents.push(["current",installed,resolved]);return globalThis.__rinUpdaterOwnerCurrent === true}
    export async function resolveGitCommitForRelease(repo,request){globalThis.__rinUpdaterOwnerEvents.push(["resolve",repo,request]);return {...request,ref:"owner-ref",archiveUrl:"https://example.test/archive",sourceLabel:request.sourceLabel||"owner resolved"}}
    export function createUpdateRuntimeSourceWorkspace(release){const tempRoot=path.join(process.env.RIN_TEST_UPDATER_ROOT,"workspace");const sourceRoot=path.join(tempRoot,"source");fs.mkdirSync(sourceRoot,{recursive:true});const releaseFile=path.join(tempRoot,"release.json");fs.writeFileSync(releaseFile,JSON.stringify(release));globalThis.__rinUpdaterOwnerEvents.push(["workspace",release]);return {tempRoot,sourceRoot,releaseFile}}
    export async function prepareUpdateRuntimeSource(options){globalThis.__rinUpdaterOwnerEvents.push(["prepare",options.release,options.workspace])}
    export async function runUpdateCommand(command,args,options){globalThis.__rinUpdaterOwnerEvents.push(["run",command,args,options])}
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
 if(replacements[specifier]) return {url:replacements[specifier],shortCircuit:true};
 const resolved=await nextResolve(specifier,context);
 for(const [target,url] of Object.entries(replacements)) if(!target.startsWith("@")&&resolved.url.endsWith(target)) return {url,shortCircuit:true};
 return resolved;
}`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
