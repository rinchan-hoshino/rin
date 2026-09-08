import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {startDaemon} from '../dist/daemon.js';
import {writeNerveLauncher} from '../dist/install/setup.js';
import {ensureNerveMcp} from '../dist/install/nerve.js';
import {activateNerveMcp} from '../dist/install/nerve-service.js';
import {runUpdateMigrations} from '../dist/install/migrations.js';

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'rin-nerve-runtime-'));
  const codexHome=join(home,'codex'),sha='a'.repeat(40),release=join(home,'releases',sha);
  let daemon,current,starts=0;
  const children=new Set();
  t.after(async()=>{
    for(const child of children) {
      if(child.exitCode===null && child.signalCode===null) {
        const exited=once(child,'exit');child.kill();await exited;
      }
    }
    await daemon?.stop();
    await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:50});
  });
  await mkdir(codexHome);await mkdir(release,{recursive:true});
  const source=resolve(dirname(fileURLToPath(import.meta.url)),'../src');
  await symlink(source,join(release,'src'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',current:sha,node:process.execPath,repository:'/unused',codexHome}));
  await writeNerveLauncher(home);
  const command={command:'unused-codex',args:[]};
  const run=async(executable,args,{cwd,env})=>{
    assert.equal(executable,command.command);assert.notEqual(cwd,process.cwd());assert.equal(env.CODEX_HOME,codexHome);
    assert.deepEqual(args,['mcp','get','nerve','--json']);
    return current?{code:0,stdout:JSON.stringify(current)}:{code:1,stderr:"No MCP server named 'nerve' found"};
  };
  const writeConfig=async({edits})=>{
    current ??= {transport:{}};
    for(const {keyPath,value} of edits) {
      const key=keyPath.replace('mcp_servers.nerve.','');
      if(key==='enabled')current.enabled=value;
      else if(key==='env.NERVE_CONFIG')(current.transport.env ??= {}).NERVE_CONFIG=value;
      else {assert.ok(['command','args'].includes(key));current.transport[key]=value;}
    }
  };
  const options={home,codexHome,command,run,writeConfig};
  const service={
    isRunning:async()=>Boolean(daemon),
    start:async()=>{assert.equal(daemon,undefined);starts++;daemon=await startDaemon(join(home,'private/daemon.json'),{env:{},log:{info(){},error(){}},ensureAppServer:async()=>{}});},
    stop:async()=>{await daemon?.stop();daemon=undefined;},
  };
  async function verifyMcp() {
    assert.ok(current);assert.equal(current.enabled,true);
    assert.deepEqual(current.transport.args,[join(home,'nerve-mcp-run.mjs')]);
    const child=spawn(current.transport.command,current.transport.args,{env:{...process.env,...current.transport.env},stdio:['pipe','pipe','pipe']});
    children.add(child);
    const pending=new Map();let nextId=0,stderr='';
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      const message=JSON.parse(line),entry=pending.get(message.id);
      if(entry){pending.delete(message.id);message.error?entry.reject(new Error(JSON.stringify(message.error))):entry.accept(message.result);}
    });
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const rejectAll=error=>{for(const entry of pending.values())entry.reject(error);pending.clear();};
    child.on('error',rejectAll);
    child.on('exit',code=>rejectAll(new Error(`MCP exited ${code}: ${stderr}`)));
    const request=(method,params={})=>new Promise((accept,reject)=>{
      const id=++nextId;pending.set(id,{accept,reject});
      child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
    });
    try {
      const initialized=await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'runtime-test',version:'1'}});
      assert.equal(initialized.serverInfo.name,'nerve');
      const listed=await request('tools/list');
      assert.equal(listed.tools.length,9);assert.ok(listed.tools.some(tool=>tool.name==='nerve_status'));assert.ok(listed.tools.some(tool=>tool.name==='nerve_create_task'));
      const status=await request('tools/call',{name:'nerve_status',arguments:{}});
      assert.equal(status.isError,false);
      const health=JSON.parse(status.content[0].text);
      assert.equal(health.ok,true);assert.deepEqual(health.targets,[]);
    } finally {
      if(child.exitCode===null && child.signalCode===null) {
        const exited=once(child,'exit');child.stdin.end();await exited;
      }
      children.delete(child);lines.close();
    }
  }
  return {home,options,service,verifyMcp,get starts(){return starts;},removeMcp(){current=undefined;}};
}

test('fresh managed Nerve serves real MCP initialization, tools and health through stable launcher',{timeout:15000},async t=>{
  const f=await fixture(t),nerve=await ensureNerveMcp(f.options);
  assert.equal(nerve.initialized,true);assert.equal(nerve.needsActivation,true);
  await activateNerveMcp({home:f.home,service:f.service,nerve});
  assert.equal(f.starts,1);
  await f.verifyMcp();
});

test('update repairs a deleted MCP registration without changing or restarting the real Nerve service',{timeout:15000},async t=>{
  const f=await fixture(t),nerve=await ensureNerveMcp(f.options);
  await activateNerveMcp({home:f.home,service:f.service,nerve});
  const configBefore=await readFile(nerve.configPath,'utf8');
  const secretsBefore=await readFile(join(dirname(nerve.configPath),'secrets.json'),'utf8');
  f.removeMcp();
  const result=await runUpdateMigrations({...f.options,service:f.service,ensureMcp:options=>ensureNerveMcp({...options,run:f.options.run})});
  assert.equal(result.nerve.registered,true);assert.equal(result.nerve.initialized,false);assert.equal(result.nerve.needsActivation,false);
  assert.equal(f.starts,1);
  assert.equal(await readFile(nerve.configPath,'utf8'),configBefore);
  assert.equal(await readFile(join(dirname(nerve.configPath),'secrets.json'),'utf8'),secretsBefore);
  await f.verifyMcp();
});
