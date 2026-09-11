import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {allowed,chatAllowed,quietEnabled,validateConfig} from '../dist/chat/policy.js';
import {ChatBridge} from '../dist/chat/bridge.js';

test('chat admission is deny-first and commands bypass chat lists but never identity',()=>{
  const config={id:'chat',type:'telegram',allowUsers:['owner'],allowChats:['allowed',{chatId:'topic-chat',topicId:'one'}],denyChats:['blocked',{chatId:'topic-chat',topicId:'denied'}],dmOnly:true};
  const message={id:'m',chatId:'allowed',userId:'owner',kind:'dm',text:'hello'};
  assert.equal(chatAllowed(config,message),true);
  assert.equal(allowed(config,{...message,chatId:'blocked'}),false);
  assert.equal(allowed(config,{...message,chatId:'missing'}),false);
  assert.equal(allowed(config,{...message,chatId:'topic-chat',topicId:'one'}),true);
  assert.equal(allowed(config,{...message,chatId:'topic-chat',topicId:'denied'}),false);
  assert.equal(allowed(config,{...message,chatId:'blocked',kind:'group',mentioned:false,text:'/help'},{command:true}),true);
  assert.equal(allowed(config,{...message,chatId:'blocked',userId:'stranger',text:'/help'},{command:true}),false);
});

test('chat rule and agent configuration fail closed',()=>{
  assert.throws(()=>validateConfig({agent:{type:'pi'},adapters:[{id:'a',type:'telegram',allowUsers:['owner'],allowChats:[{}]}],bindings:[]}),/allowChats/);
  for(const type of ['codex','claude-code','pi','opencode'])assert.doesNotThrow(()=>validateConfig({agent:{type},adapters:[{id:'a',type:'telegram',allowUsers:['owner'],autoBind:{cwd:'/tmp'}}],bindings:[]}));
  assert.throws(()=>validateConfig({agent:{type:'unknown'},adapters:[],bindings:[]}),/agent.type/);
  assert.throws(()=>validateConfig({agent:{type:'codex',command:'codex'},adapters:[],bindings:[]}),/argv array/);
  assert.throws(()=>validateConfig({agent:{type:'claude-code',cwd:'relative'},adapters:[],bindings:[]}),/absolute path/);
  assert.throws(()=>validateConfig({agent:{type:'opencode',env:{TOKEN:1}},adapters:[],bindings:[]}),/string values/);
});

test('agent configuration requires an explicit Codex adapter',()=>{
  const config=validateConfig({agent:{type:'codex',command:['codex-fixture'],codexHome:'/tmp/codex',endpoint:'ws://127.0.0.1:4500'},adapters:[],bindings:[]});
  assert.deepEqual(config.agent,{type:'codex',command:['codex-fixture'],codexHome:'/tmp/codex',endpoint:'ws://127.0.0.1:4500'});
});

test('quiet forms normalize consistently',()=>{
  for(const value of [true,'quiet',{enabled:true},{quiet:true},{mode:'quiet'}])assert.equal(quietEnabled(value),true);
  for(const value of [false,undefined,'loud',{enabled:false},{mode:'normal'}])assert.equal(quietEnabled(value),false);
});

test('quiet hides progress, commentary, summaries and questions while final and error stay visible',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-quiet-')),sent=[];let receive,queued=0;
  const binding={adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true};
  const bridge=new ChatBridge({dataDir,agent:{type:'pi'},quiet:{default:true},adapters:[{id:'chat',type:'telegram',allowUsers:['owner']}],bindings:[binding]},{
    agent:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>{queued++;return{transport:'test',turnId:'turn'};}},
    adapterFactory:async()=>({capabilities:{edit:true,typing:true},start:async fn=>{receive=fn;},stop:async()=>{},typing:async()=>assert.fail('quiet route must not type'),delete:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),
    log:{info(){},warn(){},error(){}},
  });
  try{
    await bridge.start();await receive({id:'input',chatId:'dm',userId:'owner',kind:'dm',text:'run'});await bridge.submit();assert.equal(queued,1);
    bridge.event({threadId:'thread',turnId:'turn',type:'started'});
    for(const [phase,text] of [['commentary','work'],['summary','summary'],['question','question']])bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:phase,phase,text});
    bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'final',phase:'final',text:'done'});
    bridge.event({threadId:'thread',turnId:'failed',type:'failed'});
    await bridge.flush();
    assert.deepEqual(sent.map(output=>output.text),['done','本轮执行未完成，请在所用 agent 中查看错误后继续。']);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('per-route quiet override wins over the default',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-quiet-route-')),sent=[];
  const binding={adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true},key=JSON.stringify(['chat','dm']);
  const bridge=new ChatBridge({dataDir,agent:{type:'pi'},quiet:{default:true,byRoute:{[key]:false}},adapters:[{id:'chat',type:'telegram',allowUsers:['owner']}],bindings:[binding]},{
    agent:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({})},
    adapterFactory:async()=>({capabilities:{edit:true},start:async()=>{},stop:async()=>{},delete:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log:{info(){},warn(){},error(){}},
  });
  try{await bridge.start();bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'comment',phase:'commentary',text:'visible'});await bridge.flush();assert.match(sent[0].text,/visible/);}
  finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});


test('disabled unsupported adapters remain inert through bridge startup',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-disabled-adapter-'));
  const config={dataDir,agent:{type:'pi'},adapters:[{id:'retired',type:'retired-transport',enabled:false,allowUsers:[]}],bindings:[{adapter:'retired',chatId:'old-chat',kind:'dm',threadId:'old-thread',mirror:true}]};
  const before=JSON.stringify(config.adapters);
  const bridge=new ChatBridge(config,{
    agent:{start:async()=>{},stop:async()=>{},watch:async()=>assert.fail('disabled adapter must not watch sessions'),queue:async()=>assert.fail('disabled adapter must not submit work')},
    adapterFactory:async()=>assert.fail('disabled adapter must not load a transport'),
    log:{info(){},warn(){},error(){}},
  });
  try{await bridge.start();assert.equal(bridge.adapters.size,0);assert.equal(JSON.stringify(config.adapters),before);}finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
  for(const enabled of [true,undefined])assert.throws(()=>validateConfig({...config,adapters:[{...config.adapters[0],enabled}]}),/Unsupported adapter type/);
});
