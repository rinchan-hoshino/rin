import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../dist/chat/bridge.js';
import {validateConfig} from '../dist/chat/policy.js';

test('shipped chat template enables lazy binding without enabling adapters',()=>{
 const config=JSON.parse(readFileSync(new URL('../examples/chat.json',import.meta.url),'utf8'));
 validateConfig(config);
 assert.equal(config.bindings.length,0);
 assert.ok(config.adapters.length > 0);
 for(const adapter of config.adapters){
  assert.equal(adapter.enabled,false);
  assert.deepEqual(adapter.allowUsers,[]);
  assert.deepEqual(adapter.autoBind,{cwd:'/absolute/path/to/chat-workspace'});
 }
});

const message=(chatId,id='1',extra={})=>({id,chatId,kind:'group',userId:'owner',mentioned:true,text:'hello',...extra});
function fixture(t,createThread) {
 const dataDir=mkdtempSync(join(tmpdir(),'rin-auto-bind-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
 const config={dataDir,adapters:[{id:'discord',type:'discord',allowUsers:['owner'],dmOnly:false,autoBind:{cwd:dataDir,excludedChatIds:['casual']}}],bindings:[]};
 const queue=[];const watches=[];const contexts=[];
 const make=()=>new ChatBridge(config,{agent:{start:async()=>{},stop:async()=>{},watch:async id=>watches.push(id),createThread,queue:async(id,input)=>{queue.push({id,input});return{messageId:'queued'};}},adapterFactory:async(_config,context)=>{contexts.push(context);return{capabilities:{maxText:2000},start:async()=>{},stop:async()=>{},send:async()=>({id:'sent'})};},log:{info(){},warn(){},error(){}}});
 return{config,make,queue,watches,contexts};
}
test('first admitted message creates one task; concurrent messages and restart reuse it',async t=>{
 let creates=0,release;const f=fixture(t,async()=>{creates++;await new Promise(resolve=>release=resolve);return'new-task';});let b=f.make();await b.start();
 try{
  assert.equal(creates,0);
  assert.equal(f.contexts[0].isBound(message('channel')),true);
  assert.equal(f.contexts[0].isBound(message('casual')),false);
  const first=b.receive(f.config.adapters[0],message('channel','1'));const second=b.receive(f.config.adapters[0],message('channel','2'));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(creates,1);release();await Promise.all([first,second]);await b.submit();assert.equal(f.queue.length,2);assert(f.queue.every(x=>x.id==='new-task'));
  await b.stop();b=f.make();await b.start();await b.receive(f.config.adapters[0],message('channel','3'));await b.submit();assert.equal(creates,1);assert.equal(f.queue.length,3);
 }finally{await b.stop();}
});
test('excluded chats, unauthorized messages, missing mentions and commands never create tasks',async t=>{
 let creates=0;const f=fixture(t,async()=>{creates++;return'x';}),b=f.make();await b.start();
 try{
  for(const m of [message('casual'),message('x','2',{userId:'stranger'}),message('x','3',{mentioned:false}),message('x','4',{text:'/help'})])await b.receive(f.config.adapters[0],m);
  assert.equal(creates,0);assert.equal(f.queue.length,0);
 }finally{await b.stop();}
});
test('different channels create independent tasks and explicit bindings win',async t=>{
 let creates=0;const f=fixture(t,async()=>`task-${++creates}`);f.config.bindings.push({adapter:'discord',chatId:'existing',kind:'group',threadId:'existing-task',mirror:true});const b=f.make();await b.start();
 try{for(const ch of ['a','b','existing'])await b.receive(f.config.adapters[0],message(ch));await b.submit();assert.equal(creates,2);assert.deepEqual(new Set(f.queue.map(x=>x.id)),new Set(['task-1','task-2','existing-task']));}finally{await b.stop();}
});
test('uncertain creation is durable and is not replayed after restart',async t=>{
 let creates=0;const f=fixture(t,async()=>{creates++;throw Error('timeout');});let b=f.make();await b.start();
 try{await b.receive(f.config.adapters[0],message('x'));await b.stop();b=f.make();await b.start();await b.receive(f.config.adapters[0],message('x','2'));assert.equal(creates,1);assert.equal(f.queue.length,0);}finally{await b.stop();}
});
test('auto binding validates its working directory and exclusions',()=>{
 for(const autoBind of [true,{cwd:'relative'},{cwd:'/tmp',excludedChatIds:[1]}])assert.throws(()=>validateConfig({adapters:[{id:'x',type:'discord',allowUsers:['owner'],autoBind}],bindings:[]}),/autoBind/);
});
