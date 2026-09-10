import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CliAgentBridge} from '../dist/agents/cli.js';
import {createAgentBridge} from '../dist/agents/factory.js';
import {ChatBridge} from '../dist/chat/bridge.js';

const subprocess={timeout:10000,skip:process.platform==='win32' && 'fixture executable uses a POSIX shebang'};
const types=['claude-code','pi','opencode'];
const input=text=>({text,files:[]});
const drain=bridge=>Promise.all([...bridge.tails.values()]);

// A protocol fixture, not authenticated agent acceptance. Native session state
// is separate from Rin's SQLite so tests detect accidental fresh invocations.
async function executable(t,type){
  const dir=await mkdtemp(join(tmpdir(),'rin-agent-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'agent-fixture.mjs'),log=join(dir,'calls.jsonl'),sessions=join(dir,'native.json');
  await writeFile(sessions,JSON.stringify({'existing-session':[]}));
  await writeFile(path,String.raw`#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2),type=process.env.AGENT_TYPE;
process.stdin.setEncoding('utf8');let text='';for await(const part of process.stdin)text+=part;
if(type==='claude-code')text=JSON.parse(text).message.content[0].text;
const flag=type==='claude-code'?'--resume':'--session',at=args.indexOf(flag);
const fresh=at===-1,id=fresh?randomUUID():args[at+1];
const native=JSON.parse(readFileSync(process.env.SESSIONS,'utf8'));
if(!fresh && !native[id]){console.error('Unknown native session');process.exit(1);}
const call={args,text,id,fresh,cwd:process.cwd()};
const log=phase=>appendFileSync(process.env.CALLS,JSON.stringify({...call,phase})+'\n');log('start');
if(process.env.OUTCOME==='uncertain')process.exit(0);
const events=[];
const meta=nativeId=>type==='claude-code'?{type:'system',subtype:'init',session_id:nativeId}:type==='pi'?{type:'session',id:nativeId}:{type:'step_start',sessionID:nativeId};
events.push(meta(id));
if(process.env.OUTCOME==='mismatch')events.push(meta('wrong-session'));
await new Promise(r=>setTimeout(r,Number(process.env.DELAY || 0)));
native[id]=[...(native[id] || []),text];writeFileSync(process.env.SESSIONS,JSON.stringify(native));
const answer='answer: '+text,failed=process.env.OUTCOME==='error';
if(type==='claude-code'){
 events.push({type:'assistant',message:{content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:'intermediate'}]}});
 events.push({type:'result',subtype:failed?'error_during_execution':'success',session_id:id,is_error:failed,result:answer});
}else if(type==='pi'){
 const message={role:'assistant',stopReason:failed?'error':'stop',content:[{type:'thinking',thinking:'private reasoning'},{type:'text',text:answer}]};
 events.push({type:'message_end',message:{role:'toolResult',content:[{type:'text',text:'private tool output'}]}});
 events.push({type:'message_end',message},{type:'agent_end',messages:[message]});
}else{
 events.push({type:'reasoning',sessionID:id,part:{text:'private reasoning'}});
 events.push({type:'tool_use',sessionID:id,part:{state:{output:'private tool output'}}});
 events.push({type:'text',sessionID:id,part:{text:answer}});
 if(failed)events.push({type:'error',sessionID:id,error:{name:'APIError'}});
 events.push({type:'step_finish',sessionID:id,part:{reason:'stop'}});
}
let output=Buffer.from(events.map(e=>JSON.stringify(e)).join('\n'));
if(process.env.CHUNK){for(let i=0;i<output.length;i+=7){process.stdout.write(output.subarray(i,i+7));await new Promise(r=>setImmediate(r));}}
else process.stdout.write(output);
log('end');
`);
  await chmod(path,0o755);
  return{dir,path,log,sessions,config:{type,command:path,cwd:tmpdir(),env:{AGENT_TYPE:type,CALLS:log,SESSIONS:sessions}},calls:async()=> (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}

function agent(f,store=new Map()) {
  const bridge=new CliAgentBridge(f.config),events=[];
  bridge.getCursor=key=>structuredClone(store.get(key));
  bridge.setCursor=(key,value)=>store.set(key,structuredClone(value));
  bridge.onEvent=event=>events.push(event);
  return{bridge,events,store};
}

for(const type of types)test(type+' resumes explicit sessions and exposes only the final answer',subprocess,async t=>{
  const f=await executable(t,type),{bridge,events}=agent(f);await bridge.start();
  const receipt=await bridge.queue('existing-session',input('--help\n@file 中文'));
  await drain(bridge);await bridge.stop();
  assert.equal(receipt.transport,type+'-cli');assert.ok(receipt.turnId);
  const call=(await f.calls())[0];
  assert.equal(call.fresh,false);assert.equal(call.text,'--help\n@file 中文');
  assert(!call.args.includes(call.text));
  assert.deepEqual(events.map(event=>event.type),['started','text','completed']);
  assert.equal(events[1].text,'answer: --help\n@file 中文');
});

for(const type of types)test(type+' automatically creates independent chats and keeps sessions across SQLite restart',subprocess,async t=>{
  const f=await executable(t,type);f.config.env.DELAY='20';
  const config=()=>({dataDir:f.dir,agent:f.config,adapters:[{id:'chat',type:'telegram',allowUsers:['owner'],autoBind:{cwd:f.dir}}],bindings:[]});
  const make=()=>new ChatBridge(config(),{agent:new CliAgentBridge(f.config),adapterFactory:async()=>({capabilities:{edit:false},start:async()=>{},stop:async()=>{},send:async()=>({id:'sent'})}),log:{info(){},warn(){},error(){}}});
  const message=chatId=>({id:'1',chatId,kind:'dm',userId:'owner',text:'hello'});
  let b=make();await b.start();
  try {
    const first=await b.ensureBinding(b.config.adapters[0],message('first'));
    const receipt1=b.agent.queue(first.threadId,input('one')),receipt2=b.agent.queue(first.threadId,input('two'));
    await Promise.all([receipt1,receipt2]);await drain(b.agent);
    await b.stop();b=make();await b.start();
    const restored=await b.ensureBinding(b.config.adapters[0],message('first'));
    assert.equal(restored.threadId,first.threadId);
    await b.agent.queue(restored.threadId,input('three'));await drain(b.agent);
    const other=await b.ensureBinding(b.config.adapters[0],message('second'));
    await b.agent.queue(other.threadId,input('separate'));await drain(b.agent);
    const calls=await f.calls(),starts=calls.filter(c=>c.phase==='start');
    assert.deepEqual(calls.map(c=>c.phase),['start','end','start','end','start','end','start','end']);
    assert.deepEqual(starts.map(c=>c.fresh),[true,false,false,true]);
    assert.equal(new Set(starts.slice(0,3).map(c=>c.id)).size,1);
    assert.notEqual(starts[3].id,starts[0].id);
    const workspace=await realpath(f.dir);assert(starts.every(c=>c.cwd===workspace));
    const native=JSON.parse(await readFile(f.sessions,'utf8'));
    assert.deepEqual(native[starts[0].id],['one','two','three']);
    assert.deepEqual(native[starts[3].id],['separate']);
  } finally {await b.stop();}
});

for(const type of types)test(type+' native error in a zero-exit stream is a failed turn',subprocess,async t=>{
  const f=await executable(t,type);f.config.env.OUTCOME='error';
  const {bridge,events}=agent(f);await bridge.start();
  const id=await bridge.createThread({cwd:f.dir});await bridge.queue(id,input('hello'));await drain(bridge);await bridge.stop();
  assert.deepEqual(events.map(e=>e.type),['started','failed']);
});

test('unconfirmed first creation is not repeated after restart',subprocess,async t=>{
  const f=await executable(t,'pi');f.config.env.OUTCOME='uncertain';
  const first=agent(f);await first.bridge.start();
  const id=await first.bridge.createThread({cwd:f.dir});await first.bridge.queue(id,input('one'));await drain(first.bridge);await first.bridge.stop();
  assert.deepEqual(first.events.map(e=>e.type),['started','failed']);
  const second=agent(f,first.store);await second.bridge.start();
  await assert.rejects(second.bridge.queue(id,input('two')),/creation was not confirmed/);
  await second.bridge.stop();assert.equal((await f.calls()).length,1);
});

test('failed spawn can be retried without hanging or losing the reserved conversation',subprocess,async t=>{
  const f=await executable(t,'pi'),{bridge,events}=agent(f);bridge.config.command=join(f.dir,'missing');await bridge.start();
  const id=await bridge.createThread({cwd:f.dir});await assert.rejects(bridge.queue(id,input('one')),/ENOENT/);await drain(bridge);
  bridge.config.command=f.path;await bridge.queue(id,input('two'));await drain(bridge);await bridge.stop();
  assert.deepEqual(events.map(e=>e.type),['failed','started','text','completed']);
  assert.equal((await f.calls())[0].fresh,true);
});

for(const type of types)test(type+' preserves chunked UTF-8 output and rejects a session switch',subprocess,async t=>{
  const f=await executable(t,type);f.config.env.CHUNK='1';const {bridge,events}=agent(f);await bridge.start();
  const id=await bridge.createThread({cwd:f.dir});await bridge.queue(id,input('你好，世界 👋'));await drain(bridge);
  assert.equal(events.find(e=>e.type==='text')?.text,'answer: 你好，世界 👋');
  events.length=0;bridge.config.env.OUTCOME='mismatch';await bridge.queue(id,input('two'));await drain(bridge);await bridge.stop();
  assert.deepEqual(events.map(e=>e.type),['started','failed']);
});

test('stop prevents queued turns from spawning after the running turn is stopped',subprocess,async t=>{
  const f=await executable(t,'pi');f.config.env.DELAY='1000';const {bridge}=agent(f);await bridge.start();
  const id=await bridge.createThread({cwd:f.dir});await bridge.queue(id,input('one'));
  const rejected=assert.rejects(bridge.queue(id,input('two')),/stopping/);
  await bridge.stop();await rejected;
  assert.equal(bridge.children.size,0);assert.equal(bridge.tails.size,0);
});

test('factory supports session creation for every agent and reserves CLI session controls',()=>{
  for(const type of ['codex',...types])assert.equal(typeof createAgentBridge({type}).createThread,'function');
  for(const type of types)assert.throws(()=>createAgentBridge({type,extraArgs:[type==='claude-code'?'--resume=x':'--session=x']}),/session or output controls/);
  assert.throws(()=>createAgentBridge({type:'unknown'}),/Unsupported agent/);
});
