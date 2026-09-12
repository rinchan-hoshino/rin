import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {startDaemon} from '../dist/daemon.js';

const quietLog={info(){},warn(){},error(){}};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'rin-daemon-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const write=(name,value)=>{const path=join(dir,name);writeFileSync(path,JSON.stringify(value));return path;};
  return{dir,write};
}

test('rejects a daemon with no configured work',async t=>{
  const f=fixture(t);await assert.rejects(startDaemon(f.write('daemon.json',{chat:null,nerve:null})),/No configured work/);
});

test('starts Nerve before chat, creates only the configured agent client, and stops in reverse order',async t=>{
  const f=fixture(t),events=[],dataDir=join(f.dir,'chat-data');
  const chatFile=f.write('chat.json',{}),nerveFile=f.write('nerve.json',{database:'state/events.sqlite',cwd:'work',targets:{out:{type:'command',argv:['true'],cwd:'target-work'}}});
  const daemonFile=f.write('daemon.json',{chat:chatFile,nerve:nerveFile});
  class FakeStore{constructor(path){this.path=path;events.push('store');}recover(){events.push('recover');return 0;}close(){events.push('store.close');}}
  class FakeNerve{constructor(config){this.config=config;this.running=new Set();events.push('nerve');}async tick(){events.push('tick');}async close(){events.push('nerve.close');}}
  const makeServer=()=>({listening:false,once(name,fn){this[name+'Handler']=fn;},off(){},listen(){this.listening=true;events.push('listen');queueMicrotask(()=>this.listeningHandler());},address(){return{port:4321};},close(fn){this.listening=false;events.push('server.close');fn();}});
  class FakeChat{async start(){events.push('chat.start');}async stop(){events.push('chat.stop');}}
  const agent={start:async()=>assert.fail('FakeChat owns no agent lifecycle')};
  const daemon=await startDaemon(daemonFile,{nerveToken:'x'.repeat(24),log:quietLog,intervalMs:60_000,dependencies:{
    readChatConfig:()=>({dataDir,agent:{type:'pi'},adapters:[],bindings:[]}),createLogger:()=>quietLog,adapterFactory:async()=>{},ChatBridge:FakeChat,
    createAgentBridge:config=>{events.push(['agent',config.type]);return agent;},Store:FakeStore,Nerve:FakeNerve,makeServer,validateNerveConfig(){},
  }});
  assert.deepEqual(events.slice(0,7),['store','nerve','listen','recover','tick',['agent','pi'],'chat.start']);
  assert.equal(daemon.nerve.config.database,join(dirname(nerveFile),'state/events.sqlite'));
  assert.equal(daemon.nerve.config.cwd,join(dirname(nerveFile),'work'));
  assert.equal(daemon.nerve.config.targets.out.cwd,join(dirname(nerveFile),'target-work'));
  assert.equal(readFileSync(join(dataDir,'bridge.pid'),'utf8'),String(process.pid));
  await daemon.stop();assert.ok(events.indexOf('chat.stop')<events.indexOf('nerve.close'));assert.equal(existsSync(join(dataDir,'bridge.pid')),false);
});

test('chat PID lock blocks before bridge or agent construction',async t=>{
  const f=fixture(t),dataDir=join(f.dir,'chat-data'),chatFile=f.write('chat.json',{}),daemonFile=f.write('daemon.json',{chat:chatFile});
  let agents=0,bridges=0;
  const dependencies={readChatConfig:()=>({dataDir,agent:{type:'opencode'},adapters:[],bindings:[]}),createAgentBridge:()=>{agents++;return{};},ChatBridge:class{constructor(){bridges++;}async start(){}async stop(){}}};
  const first=await startDaemon(daemonFile,{log:quietLog,dependencies});
  await assert.rejects(startDaemon(daemonFile,{log:quietLog,dependencies}),/already running/);
  assert.equal(agents,1);assert.equal(bridges,1);await first.stop();
});

test('Codex chat startup requires app-server daemon start before constructing the bridge',async t=>{
  const f=fixture(t),dataDir=join(f.dir,'chat-data'),chatFile=f.write('chat.json',{}),daemonFile=f.write('daemon.json',{chat:chatFile}),events=[];
  const dependencies={
    readChatConfig:()=>({dataDir,agent:{type:'codex',command:['codex-standalone'],codexHome:join(f.dir,'.codex')},adapters:[],bindings:[]}),
    ensureAppServer:async config=>events.push(['daemon',config.command[0]]),
    createAgentBridge:()=>{events.push('agent');return{};},
    ChatBridge:class{async start(){events.push('chat');}async stop(){}},
  };
  const daemon=await startDaemon(daemonFile,{log:quietLog,dependencies});
  assert.deepEqual(events,[['daemon','codex-standalone'],'agent','chat']);
  await daemon.stop();
});

test('chat startup failure rolls back an already started Nerve',async t=>{
  const f=fixture(t),dataDir=join(f.dir,'chat-data'),stopped=[];
  const daemonFile=f.write('daemon.json',{chat:f.write('chat.json',{}),nerve:f.write('nerve.json',{database:':memory:',targets:{}})});
  class FakeStore{recover(){return 0;}close(){stopped.push('store');}}
  class FakeNerve{async tick(){}async close(){stopped.push('nerve');}}
  const server={listening:false,once(name,fn){this[name+'Handler']=fn;},off(){},listen(){this.listening=true;queueMicrotask(()=>this.listeningHandler());},address(){return{port:1234};},close(fn){this.listening=false;stopped.push('server');fn();}};
  await assert.rejects(startDaemon(daemonFile,{nerveToken:'x'.repeat(24),log:quietLog,dependencies:{
    readChatConfig:()=>({dataDir,agent:{type:'claude-code'},adapters:[],bindings:[]}),createAgentBridge:()=>({}),
    ChatBridge:class{async start(){throw new Error('chat failed');}async stop(){stopped.push('chat');}},Store:FakeStore,Nerve:FakeNerve,makeServer:()=>server,validateNerveConfig(){},
  }}),/chat failed/);
  assert.deepEqual(stopped,['chat','server','nerve','store']);assert.equal(existsSync(join(dataDir,'bridge.pid')),false);
});

test('Nerve-only daemon serves health without constructing or managing an agent',async t=>{
  const f=fixture(t),daemonFile=f.write('daemon.json',{nerve:f.write('nerve.json',{database:'events.sqlite',cwd:'.',port:0,targets:{}})});
  let agents=0;const token='test-daemon-token-at-least-24-characters';
  const daemon=await startDaemon(daemonFile,{nerveToken:token,log:quietLog,intervalMs:60_000,dependencies:{createAgentBridge:()=>{agents++;throw new Error('must not construct');}}});
  t.after(()=>daemon.stop());assert.equal(agents,0);
  const url='http://127.0.0.1:'+daemon.address.port+'/health';
  assert.equal((await fetch(url)).status,401);assert.deepEqual(await (await fetch(url,{headers:{Authorization:'Bearer '+token}})).json(),{ok:true,targets:[],completion:'delivery-receipt'});
  await daemon.stop();await assert.rejects(fetch(url));assert.equal(existsSync(join(f.dir,'events.sqlite')),true);
});
