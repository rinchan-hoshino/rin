import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createService,daemonReady} from '../src/install/service.mjs';

async function fixture(t,platform,run) {
  const root=await mkdtemp(join(tmpdir(),'rin-service-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,"Rin home 'quoted'");const userHome=join(root,'User Home');
  await mkdir(home,{recursive:true});await writeFile(join(home,'daemon-run.mjs'),'setup-owned-launcher');
  const calls=[];
  const capture=run??(async(command,args,config)=>{calls.push({command,args,config});return {code:0,stdout:'',stderr:''};});
  const service=createService({home,userHome,platform,node:join(root,'Node $ "runtime"'),env:{PATH:'/opt/Codex $ Bin:/usr/bin',UID:'501'},run:capture,isReady:()=>service.isRunning(),timeoutMs:1000});
  return {home,userHome,service,calls};
}

test('macOS install only writes an escaped disabled LaunchAgent and preserves setup launcher ownership',async t=>{
  const {home,userHome,service,calls}=await fixture(t,'darwin');await service.install();
  assert.equal(await readFile(join(home,'daemon-run.mjs'),'utf8'),'setup-owned-launcher');
  const plist=await readFile(join(userHome,'Library','LaunchAgents','com.rin.service.plist'),'utf8');
  assert.match(plist,/com\.rin\.service/);assert.match(plist,/Node \$ &quot;runtime&quot;/);assert.match(plist,/<key>RunAtLoad<\/key><false\/>/);assert.match(plist,/Codex \$ Bin/);
  assert.deepEqual(calls.map(x=>[x.command,x.args]),[['launchctl',['disable','gui/501/com.rin.service']]]);
});

test('macOS bootstraps an absent job and can restart after stop bootout',async t=>{
  let present=false,running=false;const calls=[];
  const run=async(command,args,config)=>{calls.push({command,args,config});if(args[0]==='print')return present?{code:0,stdout:running?'state = running\npid = 42\n':'state = exited\n'}:{code:113,stderr:'Could not find service'};if(args[0]==='bootstrap'){present=true;running=true;}if(args[0]==='bootout'){present=false;running=false;}return {code:0};};
  const {service,userHome}=await fixture(t,'darwin',run);
  await service.start();await service.stop();assert.equal(present,false);await service.start();
  assert.equal(calls.filter(x=>x.args[0]==='bootstrap').length,2);assert.equal(calls.filter(x=>x.args[0]==='bootout').length,1);
  assert.ok(calls.some(x=>x.args[0]==='bootstrap'&&x.args[2]===join(userHome,'Library','LaunchAgents','com.rin.service.plist')));
});

test('macOS loaded job uses kickstart and stop waits for bootout completion',async t=>{
  let present=true,running=false,releaseBootout;const bootout=new Promise(resolve=>releaseBootout=resolve);const calls=[];
  const run=async(command,args)=>{calls.push([command,args]);if(args[0]==='print')return present?{code:0,stdout:running?'state = running\npid = 7\n':'state = exited\n'}:{code:113,stderr:'Could not find service'};if(args[0]==='kickstart')running=true;if(args[0]==='bootout'){await bootout;present=false;running=false;}return {code:0};};
  const {service}=await fixture(t,'darwin',run);await service.start();assert.ok(calls.some(([,args])=>args[0]==='kickstart'));
  let stopped=false;const stopping=service.stop().then(()=>stopped=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);releaseBootout();await stopping;assert.equal(stopped,true);
});

test('Linux unit escapes manager syntax and lifecycle persists enable state',async t=>{
  let running=false;const calls=[];
  const run=async(command,args,config)=>{calls.push({command,args,config});if(args.includes('enable')&&args.includes('--now'))running=true;if(args.includes('disable')&&args.includes('--now'))running=false;if(args.includes('is-active'))return {code:running?0:3,stdout:running?'active':'inactive'};return {code:0};};
  const {home,userHome,service}=await fixture(t,'linux',run);await service.install();await service.start();await service.stop();
  assert.equal(await readFile(join(home,'daemon-run.mjs'),'utf8'),'setup-owned-launcher');const unit=await readFile(join(userHome,'.config','systemd','user','rin.service'),'utf8');
  assert.match(unit,/ExecStart=".*Node \$\$ \\"runtime\\"" ".*daemon-run\.mjs"/);assert.match(unit,/PATH=\/opt\/Codex \$\$ Bin/);
  assert.ok(calls.some(x=>x.args.join(' ')==='--user enable --now rin.service'));assert.ok(calls.some(x=>x.args.join(' ')==='--user disable --now rin.service'));
});

test('Windows registers a disabled quoted at-logon task and captures status exits',async t=>{
  let running=false;const calls=[];
  const run=async(command,args,config)=>{calls.push({command,args,config});const script=args.at(-1);if(script.includes('Start-ScheduledTask'))running=true;if(script.includes('Stop-ScheduledTask'))running=false;if(script.includes('Get-ScheduledTask'))return {code:running?0:3};return {code:0};};
  const {home,service}=await fixture(t,'win32',run);await service.install();await service.start();await service.stop();
  assert.equal(await readFile(join(home,'daemon-run.mjs'),'utf8'),'setup-owned-launcher');assert.equal(calls.every(x=>x.command==='powershell.exe'),true);
  const install=calls[0].args.at(-1);assert.match(install,/\$ErrorActionPreference='Stop'/);assert.match(install,/New-ScheduledTaskTrigger -AtLogOn/);assert.match(install,/Register-ScheduledTask -TaskName 'Rin'/);assert.match(install,/-Argument '".*Rin home ''quoted''.*daemon-run\.mjs"'/);
  assert.match(install,/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(install,/-RestartCount 999 -RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(install,/-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries/);
  assert.match(install,/-MultipleInstances IgnoreNew/);
  const statuses=calls.filter(x=>x.args.at(-1).includes("$task=Get-ScheduledTask"));assert.ok(statuses.length>=3);assert.equal(statuses.every(x=>x.config.capture&&x.config.allowFailure),true);
});

test('readiness requires a completed startup marker for the selected release and a live process',async t=>{
  const {home}=await fixture(t,'linux');await mkdir(join(home,'private'));
  await writeFile(join(home,'install.json'),JSON.stringify({current:'a'.repeat(40)}));
  assert.equal(await daemonReady(home),false);
  await writeFile(join(home,'private/daemon-ready.json'),JSON.stringify({current:'b'.repeat(40),pid:process.pid}));
  assert.equal(await daemonReady(home),false);
  await writeFile(join(home,'private/daemon-ready.json'),JSON.stringify({current:'a'.repeat(40),pid:process.pid}));
  assert.equal(await daemonReady(home),true);
});

test('a live manager process alone does not pass startup readiness',async t=>{
  const {home}=await fixture(t,'linux');
  const service=createService({home,platform:'linux',run:async()=>({code:0}),isReady:async()=>false,timeoutMs:20,pollMs:5});
  await assert.rejects(service.start(),/did not stay running/);
});

test('status maps documented inactive states to false and propagates failures',async t=>{
  let code=4;const {service}=await fixture(t,'linux',async()=>({code,stdout:'unknown'}));assert.equal(await service.isRunning(),false);code=5;await assert.rejects(service.isRunning(),/status query failed/);
});

test('start requires two running observations and rejects an immediate crash',async t=>{
  let checks=0;const run=async(_command,args)=>args.includes('is-active')?{code:checks++===0?0:3,stdout:'inactive'}:{code:0};const {service}=await fixture(t,'linux',run);
  await assert.rejects(service.start(),/did not stay running/);assert.ok(checks>=2);
});

test('manager failures are not swallowed',async t=>{
  const failure=Error('manager unavailable');const {service}=await fixture(t,'linux',async()=>{throw failure;});
  await assert.rejects(service.install(),/manager unavailable/);await assert.rejects(service.start(),/manager unavailable/);await assert.rejects(service.stop(),/manager unavailable/);
});
