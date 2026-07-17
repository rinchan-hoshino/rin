import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-managed-runtime-service-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";

globalThis.__rinManagedOwnerEvents=[];
globalThis.__rinManagedOwnerPathExists=true;
globalThis.__rinManagedOwnerPid=321;
const managed=await import(pathToFileURL(path.resolve("dist/core/rin/managed-runtime-service.js")).href);

const created=managed.createManagedRuntimeServiceActionContext({targetUser:"alice",currentUser:"alice",installDir:"/srv/rin"});
assert.equal(created.installDir,"/srv/rin");
assert.equal(created.agentDir,"/srv/rin/agent");
assert.equal(created.isTargetUser,true);
assert.equal(created.systemctl.endsWith("systemctl")||created.systemctl==="",true);
assert.equal(created.capture([process.execPath,"-e","process.stdout.write('owner')"]),"owner");
created.exec([process.execPath,"-e",""]);
assert.equal(await created.canConnectSocket(),false);
const cross=managed.createManagedRuntimeServiceActionContext({targetUser:"bob",currentUser:"alice",installDir:""});
assert.equal(cross.installDir,"/home/bob/.rin");
assert.equal(cross.isTargetUser,false);
const defaults=managed.createManagedRuntimeServiceActionContext({targetUser:"",installDir:""});
assert.equal(defaults.targetUser.length>0,true);
assert.equal(defaults.installDir.endsWith("/.rin"),true);

const valid=managed.readManagedRuntimeService({
 installDir:"/srv/rin",targetUser:"alice",currentUser:"alice",
 readJson(file,fallback){assert.equal(file,"/srv/rin/installer.json");assert.deepEqual(fallback,{});return {service:{kind:"systemd",label:" owner.service ",path:" /tmp/owner.service "}}},
});
assert.deepEqual(valid,{kind:"systemd",label:"owner.service",path:"/tmp/owner.service"});
assert.deepEqual(managed.readManagedRuntimeService({
 installDir:"/srv/rin",targetUser:"alice",currentUser:"alice",
 readJson(){return {service:{kind:"launchd",label:"owner.agent",path:""}}},
}),{kind:"launchd",label:"owner.agent",path:undefined});
for(const service of [{kind:"other",label:"x"},{kind:"systemd",label:" "},null]){
 globalThis.__rinManagedOwnerManifest={service};
 assert.throws(()=>managed.readManagedRuntimeService({installDir:"/bad",targetUser:"a",currentUser:"a"}),/rin_managed_service_missing/);
}

function launchContext(options={}){
 const events=[];
 return {events,context:{targetUser:options.targetUser||"alice",capture(argv){events.push(argv.join(" "));if(argv[1]==="bootout"&&options.bootoutFails)throw new Error("not loaded");if(argv[1]==="bootstrap"&&options.bootstrapFails)throw new Error("bootstrap failed");return ""},exec(argv){events.push(argv.join(" "))},async canConnectSocket(){events.push("socket");return options.socket===true}}};
}
const service={kind:"launchd",label:"com.rin.owner",path:"/tmp/com.rin.owner.plist"};
{
 const {context,events}=launchContext();
 assert.equal(await managed.runManagedLaunchdServiceAction(context,service,"restart",{resolveDomain:()=>"gui/501",async waitForDaemonUnavailable(){events.push("wait");return true}}),service.label);
 assert.deepEqual(events,["launchctl bootout gui/501/com.rin.owner","wait","launchctl bootstrap gui/501 /tmp/com.rin.owner.plist"]);
}
{
 const {context}=launchContext();
 await assert.rejects(()=>managed.runManagedLaunchdServiceAction(context,service,"restart",{resolveDomain:()=>"gui/501",waitForDaemonUnavailable:async()=>false}),/rin_launchd_daemon_stop_incomplete/);
}
{
 const {context}=launchContext({bootoutFails:true,socket:true});
 await assert.rejects(()=>managed.runManagedLaunchdServiceAction(context,service,"restart",{resolveDomain:()=>"gui/501"}),/rin_launchd_daemon_stop_incomplete/);
}
{
 const {context}=launchContext({bootoutFails:true,socket:true});
 await assert.rejects(()=>managed.runManagedLaunchdServiceAction(context,service,"stop",{resolveDomain:()=>"gui/501"}),/rin_launchd_daemon_stop_incomplete/);
}
{
 const {context,events}=launchContext({bootoutFails:true,socket:false});
 assert.equal(await managed.runManagedLaunchdServiceAction(context,service,"stop",{resolveDomain:()=>"gui/501"}),service.label);
 assert.equal(events.includes("socket"),true);
}
{
 const {context}=launchContext();
 await assert.rejects(()=>managed.runManagedLaunchdServiceAction(context,service,"stop",{resolveDomain:()=>"gui/501",waitForDaemonUnavailable:async()=>false}),/rin_launchd_daemon_stop_incomplete/);
}
{
 const {context}=launchContext();
 assert.equal(await managed.runManagedLaunchdServiceAction(context,service,"start",{resolveDomain:()=>"gui/501"}),service.label);
}
{
 const {context,events}=launchContext({bootstrapFails:true});
 assert.equal(await managed.runManagedLaunchdServiceAction(context,service,"start",{resolveDomain:()=>"gui/501"}),service.label);
 assert.equal(events.at(-1),"launchctl kickstart gui/501/com.rin.owner");
}
await assert.rejects(()=>managed.runManagedLaunchdServiceAction(launchContext().context,{kind:"launchd",label:"missing"},"start"),/rin_managed_service_missing_path:missing/);

const actionEvents=[];
const base={installDir:"/srv/rin",targetUser:"alice",currentUser:"alice",isTargetUser:true,agentDir:"/srv/rin/agent",systemctl:"/usr/bin/systemctl",exec(argv){actionEvents.push(["exec",argv])},capture(argv){actionEvents.push(["capture",argv]);return ""},async canConnectSocket(){return false}};
assert.equal(await managed.tryManagedServiceAction(base,"start",{kind:"systemd",label:"owner.service",path:"/tmp/owner"}),"owner.service");
assert.equal(actionEvents.some(([name,args])=>name==="exec"&&args.includes("restart")),true);
globalThis.__rinManagedOwnerSystemdFails=true;
await assert.rejects(()=>managed.tryManagedServiceAction(base,"stop",{kind:"systemd",label:"owner.service"}),/rin_managed_service_action_failed:stop:owner.service/);
globalThis.__rinManagedOwnerSystemdFails=false;
await assert.rejects(()=>managed.tryManagedServiceAction({...base,systemctl:""},"start",{kind:"systemd",label:"owner.service"}),/rin_managed_service_unsupported:systemd/);
globalThis.__rinManagedOwnerPathExists=false;
await assert.rejects(()=>managed.tryManagedServiceAction(base,"start",{kind:"systemd",label:"owner.service",path:"/missing"}),/rin_managed_service_missing_path:\/missing/);
globalThis.__rinManagedOwnerPathExists=true;
await assert.rejects(()=>managed.tryManagedServiceAction(base,"start",{kind:"other",label:"owner"}),/rin_managed_service_unsupported:other/);

const originalPlatform=Object.getOwnPropertyDescriptor(process,"platform");
const originalKill=process.kill;
try{
 Object.defineProperty(process,"platform",{configurable:true,value:"darwin"});
 assert.equal(await managed.tryManagedServiceAction(base,"start",service),service.label);
 await assert.rejects(()=>managed.tryManagedServiceAction({...base,targetUser:"missing"},"start",service),/rin_launchd_target_user_not_found:missing/);
 Object.defineProperty(process,"platform",{configurable:true,value:"linux"});
 await assert.rejects(()=>managed.tryManagedServiceAction(base,"start",service),/rin_managed_service_unsupported:launchd/);
 Object.defineProperty(process,"platform",{configurable:true,value:"win32"});
 const kills=[];process.kill=((pid,signal)=>{kills.push([pid,signal]);return true});
 let checks=[true,false,false];
 const windows={...base,async canConnectSocket(){return checks.shift()??false}};
 assert.equal(await managed.tryManagedServiceAction(windows,"restart",{kind:"windows-startup",label:"Owner Startup"}),"Owner Startup");
 assert.deepEqual(kills,[[321,"SIGTERM"]]);
 globalThis.__rinManagedOwnerPid=654;
 process.kill=((pid,signal)=>{const error=new Error("gone");error.code="ESRCH";throw error});
 assert.equal(await managed.tryManagedServiceAction({...base,async canConnectSocket(){return false}},"stop",{kind:"windows-startup",label:"Owner Startup"}),"Owner Startup");
 process.kill=((pid,signal)=>{const error=new Error("denied");error.code="EACCES";throw error});
 await assert.rejects(()=>managed.tryManagedServiceAction(base,"stop",{kind:"windows-startup",label:"Owner Startup"}),/denied/);
 process.kill=((pid,signal)=>true);
 const originalNow=Date.now;let tick=0;Date.now=()=>tick+=6000;
 assert.equal(await managed.tryManagedServiceAction({...base,async canConnectSocket(){return true}},"stop",{kind:"windows-startup",label:"Owner Startup"}),"Owner Startup");
 Date.now=originalNow;
 globalThis.__rinManagedOwnerPid=0;
 await assert.rejects(()=>managed.tryManagedServiceAction({...base,async canConnectSocket(){return true}},"stop",{kind:"windows-startup",label:"Owner Startup"}),/rin_windows_daemon_pid_missing/);
 await assert.rejects(()=>managed.tryManagedServiceAction({...base,isTargetUser:false},"start",{kind:"windows-startup",label:"Owner Startup"}),/rin_windows_daemon_cross_user_unsupported:alice/);
 Object.defineProperty(process,"platform",{configurable:true,value:"linux"});
 await assert.rejects(()=>managed.tryManagedServiceAction(base,"start",{kind:"windows-startup",label:"Owner Startup"}),/rin_managed_service_unsupported:windows-startup/);
}finally{Object.defineProperty(process,"platform",originalPlatform);process.kill=originalKill}

console.log(JSON.stringify({events:globalThis.__rinManagedOwnerEvents.length,actions:actionEvents.length}));
`;

test("managed runtime service actions preserve platform ownership and verified stop/start ordering", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-managed-service-owner-"),
  );
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
      { env: { ...process.env, HOME: root } },
    );
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.events > 10, true);
    assert.equal(summary.actions >= 3, true);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
