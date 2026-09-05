import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../src/chat/bridge.mjs';
import {COMMANDS,parseCommand} from '../src/chat/commands.mjs';

test('the built-in catalog is minimal and accepts a shared extension grammar',()=>{
  assert.deepEqual(COMMANDS.map(c=>c.name),['help','usage']);
  assert.deepEqual(parseCommand('/usage@rin_bot history --days 7'),{name:'usage',args:'history --days 7'});
  assert.deepEqual(parseCommand('/echo_2 yes',[{name:'echo_2'}]),{name:'echo_2',args:'yes'});
});

test('every admitted caller can execute usage, extension privacy stays explicit, and replay is durable',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-commands-'));let bridge,receive,usageCalls=0;const sent=[];
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','echo.mjs'),`export default {name:'echo',description:'Echo text',privateOnly:true,run:async({args})=>({text:args,target:{chatId:'wrong'}})};`);
  const originalBinding={adapter:'d',chatId:'other',kind:'dm',threadId:'existing',mirror:true};
  const config={dataDir,bindings:[originalBinding],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['a','b']}]};
  const adapter={capabilities:{edit:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},send:async(t,o)=>{sent.push({t,o});return{id:String(sent.length)};}};
  let catalog;
  const start=async()=>{
    bridge=new ChatBridge(config,{log:{info(){},warn(){},error(){}},codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async(_c,context)=>{catalog=context.commands;return adapter;},usage:async()=>{usageCalls++;return{text:'PRIVATE LIMITS'};}});await bridge.start();
  };
  const msg=(id,text,extra={})=>({id,text,chatId:'chat',kind:'dm',userId:'a',mentioned:true,...extra});
  try {
    await start();assert.deepEqual(catalog.map(c=>c.name),['help','usage','echo']);assert.deepEqual(config.bindings,[originalBinding]);
    await receive(msg('g','/usage',{kind:'group'}));await bridge.flush();assert.equal(usageCalls,1);assert.match(sent.at(-1).o.text,/PRIVATE LIMITS/);
    await receive(msg('b','/usage',{userId:'b'}));await bridge.flush();assert.equal(usageCalls,2);
    await receive(msg('ignored','/usage',{userId:'stranger'}));assert.equal(usageCalls,2);
    await Promise.all([receive(msg('u','/usage',{commandInteraction:{id:'interaction'}})),receive(msg('u','/usage'))]);await bridge.flush();
    assert.equal(usageCalls,3);assert.equal(sent.at(-1).t.commandInteraction.id,'interaction');
    await receive(msg('eg','/echo hidden',{kind:'group',userId:'b'}));await bridge.flush();assert.match(sent.at(-1).o.text,/私聊/);
    await receive(msg('e','/echo literal',{userId:'b'}));await bridge.flush();assert.equal(sent.at(-1).o.text,'literal');assert.equal(sent.at(-1).t.chatId,'chat');
    await bridge.stop();await start();const count=sent.length;await receive(msg('e','/echo literal',{userId:'b'}));await receive(msg('u','/usage'));await bridge.flush();
    assert.equal(usageCalls,3);assert.equal(sent.length,count);assert.deepEqual(config.bindings,[originalBinding]);
    await receive(msg('help','/help',{kind:'group'}));await bridge.flush();assert.match(sent.at(-1).o.text,/\/usage/);assert.doesNotMatch(sent.at(-1).o.text,/\/echo|PRIVATE|existing/);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('slow menu registration does not block readiness and its later failure is handled',async()=>{
  const {registerCommands}=await import('../src/chat/commands.mjs');let reject;const warnings=[];
  await registerCommands(()=>new Promise((_,fail)=>{reject=fail;}),{warn:m=>warnings.push(m)},'menu registration failed',5);
  assert.equal(warnings.length,0);reject(new Error('secret request metadata'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(warnings,['menu registration failed']);
});
