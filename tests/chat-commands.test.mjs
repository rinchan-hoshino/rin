import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../src/chat/bridge.mjs';
import {COMMANDS,parseCommand,commandOwner} from '../src/chat/commands.mjs';

test('single command contract parses text and mentions without exposing new or abort',()=>{
  assert.deepEqual(COMMANDS.map(c=>c.name),['help','usage','bind','status','unbind']);
  assert.deepEqual(parseCommand('/usage@rin_bot history --days 7'),{name:'usage',args:'history --days 7'});
  assert.equal(parseCommand('/new'),null);assert.equal(parseCommand('/abort'),null);
  assert.equal(commandOwner({allowUsers:['a','b']},'a'),false);
  assert.equal(commandOwner({allowUsers:['a','b'],ownerUsers:['a']},'a'),true);
});

test('private owner usage, group redaction and durable command dedupe precede side effects',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-commands-'));let bridge,receive,usageCalls=0,watches=0;const sent=[];
  const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['owner','guest'],ownerUsers:['owner']}]};
  const adapter={capabilities:{edit:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},send:async(t,o)=>{sent.push({t,o});return{id:String(sent.length)};}};
  const start=async()=>{
    bridge=new ChatBridge(config,{log:{info(){},warn(){},error(){}},codex:{start:async()=>{},stop:async()=>{},watch:async()=>{watches++;}},adapterFactory:async()=>adapter,usage:async()=>{usageCalls++;return{text:'PRIVATE ACCOUNT LIMITS'};}});await bridge.start();
  };
  const msg=(id,text,extra={})=>({id,text,chatId:'chat',kind:'dm',userId:'owner',mentioned:true,...extra});
  try {
    await start();
    await receive(msg('g','/usage',{kind:'group'}));await bridge.flush();assert.equal(usageCalls,0);assert.match(sent.at(-1).o.text,/私聊/);
    await receive(msg('guest','/usage',{userId:'guest'}));await bridge.flush();assert.equal(usageCalls,0);assert.match(sent.at(-1).o.text,/主人/);
    await receive(msg('ignored','/usage',{userId:'stranger'}));assert.equal(usageCalls,0);
    await Promise.all([receive(msg('u','/usage',{commandInteraction:{id:'interaction'}})),receive(msg('u','/usage'))]);await bridge.flush();
    assert.equal(usageCalls,1);assert.equal(sent.at(-1).t.commandInteraction.id,'interaction');
    const bind=msg('b','/bind 11111111-2222-3333-4444-555555555555');await receive(bind);await bridge.flush();assert.equal(watches,1);
    await receive(msg('un','/unbind'));await bridge.flush();assert.equal(config.bindings.length,0);
    await bridge.stop();await start();await receive(bind);await receive(msg('u','/usage'));await bridge.flush();
    assert.equal(watches,1);assert.equal(usageCalls,1);assert.equal(config.bindings.length,0);
    await receive(msg('stat','/status',{kind:'group'}));await bridge.flush();assert.doesNotMatch(sent.at(-1).o.text,/Codex|thread|模型|路径|账户|11111111/i);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('slow menu registration does not block readiness and its later failure is handled',async()=>{
  const {registerCommands}=await import('../src/chat/commands.mjs');let reject;const warnings=[];
  await registerCommands(()=>new Promise((_,fail)=>{reject=fail;}),{warn:m=>warnings.push(m)},'menu registration failed',5);
  assert.equal(warnings.length,0);reject(new Error('secret request metadata'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(warnings,['menu registration failed']);
});
