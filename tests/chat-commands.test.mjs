import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../dist/chat/bridge.js';
import {COMMANDS,parseCommand,parseCommandText} from '../dist/chat/commands.js';

test('the built-in catalog is minimal and accepts a shared extension grammar',()=>{
  assert.deepEqual(COMMANDS.map(c=>c.name),['help','usage']);
  assert.deepEqual(parseCommand('/usage@rin_bot history --days 7',COMMANDS,'self'),{name:'usage',args:'history --days 7'});
  assert.deepEqual(parseCommand('/echo_2 yes',[{name:'echo_2'}]),{name:'echo_2',args:'yes'});
  assert.deepEqual(parseCommandText('/unknown@other_bot words'),{commandLike:true,name:'unknown',target:'other_bot',args:'words',registered:false});
  assert.equal(parseCommand('/usage@other_bot',COMMANDS,'other'),null);
});

test('command-like text never becomes a prompt, and only private unknown commands reply',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-command-like-'));const sent=[],queued=[];let receive;
  const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['owner']}]};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async(...args)=>{queued.push(args);return {messageId:'q'};}},
    adapterFactory:async()=>({capabilities:{edit:false,typing:false,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log:{info(){},warn(){},error(){}}});
  const message=(id,text,kind='dm',extra={})=>({id,text,chatId:kind==='dm'?'dm':'group',userId:'owner',kind,mentioned:true,...extra});
  try{
    await bridge.start();
    await receive(message('private-unknown','/no_such_command'));
    await receive(message('unidentified-target','/usage@other_bot'));
    await receive(message('other-bot','/usage@other_bot','dm',{commandTarget:'other'}));
    await receive(message('self-target','/usage@rin_bot','dm',{commandTarget:'self'}));
    await receive(message('group-unknown','/no_such_command','group'));
    await receive(message('removed','/session'));
    await bridge.flush();
    assert.deepEqual(sent.slice(0,3).map(output=>[output.text,output.replyTo]),[
      ['Unknown command. Send /help to see available commands.','private-unknown'],
      ['Unknown command. Send /help to see available commands.','unidentified-target'],
      ['Unknown command. Send /help to see available commands.','other-bot'],
    ]);
    assert.equal(sent[3].replyTo,'self-target');assert.notEqual(sent[3].text,'Unknown command. Send /help to see available commands.');
    assert.equal(queued.length,0);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('text command replies quote the source only once on every transport',async()=>{
  for(const type of ['discord','telegram','qqbot','onebot','feishu']){
    const dataDir=mkdtempSync(join(tmpdir(),`rin-command-quote-${type}-`));const sent=[];let receive;
    const bridge=new ChatBridge({dataDir,bindings:[],adapters:[{id:'a',type,allowUsers:['owner']}]},{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},usage:async()=>({text:'x'.repeat(4000)}),
      adapterFactory:async()=>({capabilities:{edit:false,typing:false,maxText:1900},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log:{info(){},warn(){},error(){}}});
    try{
      await bridge.start();await receive({id:'source',chatId:'dm',userId:'owner',kind:'dm',text:'/usage'});await bridge.flush();
      assert.equal(sent[0].replyTo,'source',type);assert.ok(sent.slice(1).every(output=>output.replyTo===undefined),type);
    }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
  }
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
    assert.equal(usageCalls,3);assert.equal(sent.at(-1).t.commandInteraction.id,'interaction');assert.equal(sent.at(-1).o.replyTo,undefined);
    await receive(msg('eg','/echo hidden',{kind:'group',userId:'b'}));await bridge.flush();assert.match(sent.at(-1).o.text,/私聊/);
    await receive(msg('e','/echo literal',{userId:'b'}));await bridge.flush();assert.equal(sent.at(-1).o.text,'literal');assert.equal(sent.at(-1).t.chatId,'chat');
    await bridge.stop();await start();const count=sent.length;await receive(msg('e','/echo literal',{userId:'b'}));await receive(msg('u','/usage'));await bridge.flush();
    assert.equal(usageCalls,3);assert.equal(sent.length,count);assert.deepEqual(config.bindings,[originalBinding]);
    await receive(msg('help','/help',{kind:'group'}));await bridge.flush();assert.match(sent.at(-1).o.text,/\/usage/);assert.doesNotMatch(sent.at(-1).o.text,/\/echo|PRIVATE|existing/);
  } finally {await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('slow menu registration does not block readiness and its later failure is handled',async()=>{
  const {registerCommands}=await import('../dist/chat/commands.js');let reject;const warnings=[];
  await registerCommands(()=>new Promise((_,fail)=>{reject=fail;}),{warn:m=>warnings.push(m)},'menu registration failed',5);
  assert.equal(warnings.length,0);reject(new Error('secret request metadata'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(warnings,['menu registration failed']);
});

test('resolved commands own execution without requiring a reply, including native interactions and replay',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-command-completion-'));const sent=[],deleted=[];let receive,calls=0;
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','quiet.mjs'),`export default {name:'quiet',description:'Do work',run:async()=>{}};`);
  const bridge=new ChatBridge({dataDir,bindings:[],adapters:[{id:'d',type:'discord',allowUsers:['owner']}]},{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>assert.fail('commands must not reach model')},
    usage:async()=>{calls++;},log:{info(){},warn(){},error(){}},
    adapterFactory:async()=>({capabilities:{edit:false},start:async fn=>{receive=fn;},stop:async()=>{},send:async(t,o)=>{sent.push(o);return{id:'reply'};},delete:async(t,id)=>deleted.push([t.commandInteraction.id,id])}),
  });
  const msg=(id,text,extra={})=>({id,text,chatId:'dm',kind:'dm',userId:'owner',...extra});
  try{
    await bridge.start();
    await receive(msg('builtin','/usage'));await receive(msg('extension','/quiet'));
    await receive(msg('native','/quiet',{commandInteraction:{id:'ix'}}));await bridge.flush();
    assert.equal(calls,1);assert.deepEqual(sent,[]);assert.deepEqual(deleted,[['ix','ix']]);
    await receive(msg('builtin','/usage'));await receive(msg('native','/quiet',{commandInteraction:{id:'ix'}}));await bridge.flush();
    assert.equal(calls,1);assert.equal(deleted.length,1);
    for(const [index,value] of [null,{}, {text:'',files:[]}, false,{text:5},{fallbackText:'only fallback'}].entries()){
      bridge.commands.find(c=>c.name==='quiet').run=()=>value;
      await receive(msg(`result-${index}`,'/quiet'));await bridge.flush();
    }
    assert.equal(sent.length,3,'malformed results still report errors');
    bridge.commands.find(c=>c.name==='quiet').run=()=>{throw new Error('failed');};
    await receive(msg('failed','/quiet'));await bridge.flush();assert.equal(sent.length,4);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});
