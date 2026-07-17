import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-updater-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinUpdaterOwnerEvents=[];
globalThis.__rinUpdaterOwnerTargets=[];
globalThis.__rinUpdaterOwnerCurrent=false;
const updater=await import(pathToFileURL(path.resolve("dist/core/rin-install/updater.js")).href);
const i18nModule=await import(pathToFileURL(path.resolve("dist/core/rin-install/i18n.js")).href);
const i18n=i18nModule.createInstallerI18n("en_US");
const root=process.env.RIN_TEST_UPDATER_ROOT;
const installDir=path.join(root,"install");
fs.mkdirSync(installDir,{recursive:true});
fs.writeFileSync(path.join(installDir,"installer.json"),JSON.stringify({currentRelease:{release:{channel:"git",branch:"owner-branch",ref:"old"}}}));

assert.equal(updater.renderUpdaterNote(" owner note ","Owner"),"Owner\n[80]  owner note ");
assert.equal(updater.renderUpdaterNote("", ""), "[80] ");
const command=updater.buildPreparedUpdaterCommand({sourceRoot:"/prepared",releaseFile:"/prepared/release.json",currentUser:"alice",targetUser:"bob",installDir:"/home/bob/.rin",language:"zh_CN"});
assert.equal(command.command,"/prepared/runtime/node/current/bin/node");
assert.deepEqual(command.args,["/prepared/dist/app/rin-install/main.js","--update","--target-user","bob","--install-dir","/home/bob/.rin","--language","zh_CN","--yes","--preconfirmed","--release-file","/prepared/release.json"]);
assert.equal(command.options.cwd,"/prepared");

const output=[];const originalWrite=process.stdout.write;process.stdout.write=((chunk)=>{output.push(String(chunk));return true});
const base={detectCurrentUser:()=>"alice",repoRootFromHere:()=>"/repo/owner",ensureNotCancelled:(value)=>value,i18n};
try{
 await updater.startUpdater(base);
 assert.equal(output.join("").includes(i18n.noUpdateTargetsText),true);

 globalThis.__rinUpdaterOwnerTargets=[{targetUser:"alice",installDir,ownerHome:path.join(root,"home"),source:"manifest"}];
 globalThis.__rinUpdaterOwnerCurrent=true;
 await updater.startUpdater({...base,readInstalledUpdateLanguage:()=>"",releaseRequest:{channel:"stable",branch:"",version:"",explicitReleaseChannel:false}});
 assert.equal(globalThis.__rinUpdaterOwnerEvents.some(([name,request])=>name==="request"&&request.channel==="git"&&request.branch==="owner-branch"),true);

 await updater.startUpdater({...base,i18n:undefined,readInstalledRelease:()=>({channel:"stable"}),releaseRequest:{channel:"nightly",branch:"",version:"",explicitReleaseChannel:false}});
 globalThis.__rinUpdaterOwnerManifestWithoutRepo=true;
 await updater.startUpdater({...base,readInstalledRelease:()=>({channel:"invalid"}),releaseRequest:{channel:"stable",branch:"",version:"",explicitReleaseChannel:false}});
 globalThis.__rinUpdaterOwnerManifestWithoutRepo=false;
 assert.equal(globalThis.__rinUpdaterOwnerEvents.some(([name])=>name==="repo-url"),true);

 globalThis.__rinUpdaterOwnerTargets=[
  {targetUser:"first",installDir:"/first",ownerHome:"/home/first",source:"launcher"},
  {targetUser:"second",installDir:"/second",ownerHome:"/home/second",source:"manifest"},
 ];
 globalThis.__rinUpdaterOwnerSelection=1;
 await updater.startUpdater({...base,readInstalledRelease:()=>({channel:"invalid"}),releaseRequest:{channel:"nightly",branch:"",version:"",explicitReleaseChannel:true}});
 assert.equal(globalThis.__rinUpdaterOwnerEvents.some(([name,request])=>name==="request"&&request.channel==="nightly"),true);

 globalThis.__rinUpdaterOwnerCurrent=false;
 const release={channel:"stable",branch:"",version:"1.2.3",ref:"owner",archiveUrl:"https://example.test/owner.tgz",sourceLabel:"stable 1.2.3"};
 const requested={requestedInstallDir:installDir,requestedTargetUser:"alice"};
 const stdinDescriptor=Object.getOwnPropertyDescriptor(process.stdin,"isTTY");
 const stdoutDescriptor=Object.getOwnPropertyDescriptor(process.stdout,"isTTY");
 Object.defineProperty(process.stdin,"isTTY",{configurable:true,value:false});
 Object.defineProperty(process.stdout,"isTTY",{configurable:true,value:false});
 await assert.rejects(()=>updater.startUpdater({...base,...requested,release}),/rin_update_confirmation_required/);
 Object.defineProperty(process.stdin,"isTTY",{configurable:true,value:true});
 Object.defineProperty(process.stdout,"isTTY",{configurable:true,value:true});
 globalThis.__rinUpdaterOwnerConfirm=false;
 await updater.startUpdater({...base,...requested,release,confirm:async(options)=>{globalThis.__rinUpdaterOwnerEvents.push(["owner-confirm",options]);return false}});
 await updater.startUpdater({...base,...requested,releaseRequest:{channel:"stable",branch:"",version:"",explicitReleaseChannel:true},confirm:async(options)=>{globalThis.__rinUpdaterOwnerEvents.push(["fetch-confirm",options]);return false}});
 assert.equal(globalThis.__rinUpdaterOwnerEvents.some(([name])=>name==="owner-confirm"),true);
 assert.equal(globalThis.__rinUpdaterOwnerEvents.some(([name])=>name==="fetch-confirm"),true);
 globalThis.__rinUpdaterOwnerConfirm=true;

 await updater.startUpdater({...base,...requested,assumeYes:true,readInstalledRelease:()=>({channel:"stable",ref:"old"}),releaseRequest:{channel:"beta",branch:"",version:"",explicitReleaseChannel:true}});
 assert.equal(fs.existsSync(path.join(root,"workspace")),false);
 const runEvent=globalThis.__rinUpdaterOwnerEvents.find(([name])=>name==="run");
 assert.equal(runEvent[1].endsWith("/runtime/node/current/bin/node"),true);
 assert.equal(runEvent[2].includes("--preconfirmed"),true);

 let finalized;
 const result={written:{launcherPath:"/launcher",rinPath:"/rin",rinInstallPath:"/rin-install"},publishedRuntime:{currentLink:"/current",releaseRoot:"/release"},installedDocs:{pi:["/docs/pi"]},installedDocsDir:"/docs/rin",installedService:{kind:"systemd",label:"owner.service",servicePath:"/service"},daemonReady:true,serviceHint:"ready",prunedReleases:{removed:["old-a","old-b"]}};
 await updater.startUpdater({...base,...requested,release,preconfirmed:true,readInstalledUpdateLanguage:()=>"zh_CN",async runFinalizeInstallPlanInChild(options,message,status){status.writeStatus("owner");finalized={options,message,status};return result}});
 assert.equal(finalized.options.currentUser,"alice");
 assert.equal(finalized.options.targetUser,"alice");
 assert.equal(finalized.options.coreUpdate,true);
 assert.equal(finalized.options.daemonReadyTimeoutMs,30000);
 assert.equal(Object.hasOwn(finalized.options,"language"),false);
 assert.equal(typeof finalized.status.writeStatus,"function");
 assert.match(output.join(""),/\/docs\/pi/);
 assert.match(output.join(""),/owner\.service/);

 if(stdinDescriptor)Object.defineProperty(process.stdin,"isTTY",stdinDescriptor);
 if(stdoutDescriptor)Object.defineProperty(process.stdout,"isTTY",stdoutDescriptor);
}finally{process.stdout.write=originalWrite}
const names=globalThis.__rinUpdaterOwnerEvents.map(([name])=>name);
assert.equal(names.includes("manifest"),true);
assert.equal(names.includes("resolve"),true);
assert.equal(names.includes("prepare"),true);
assert.equal(names.includes("progress"),true);
console.log(JSON.stringify({events:names.length,output:output.length}));
`;

test("updater selects, confirms, prepares, applies, and reports one chosen installed target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-updater-owner-"));
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      { env: { ...process.env, RIN_TEST_UPDATER_ROOT: root } },
    );
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.events > 20, true);
    assert.equal(summary.output > 5, true);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
