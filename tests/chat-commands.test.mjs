import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../dist/chat/bridge.js';
import {COMMANDS,parseCommand,parseCommandText} from '../dist/chat/commands.js';

const log={info(){},warn(){},error(){}};
const agent={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>assert.fail('commands must not reach agent')};

test('the public built-in catalog contains only help and shares extension grammar',()=>{
  assert.deepEqual(COMMANDS.map(command=>command.name),['help']);
  assert.deepEqual(parseCommand('/help@rin_bot details',COMMANDS,'self'),{name:'help',args:'details'});
  assert.deepEqual(parseCommand('/echo_2 yes',[{name:'echo_2'}]),{name:'echo_2',args:'yes'});
  assert.deepEqual(parseCommandText('/unknown@other_bot words'),{commandLike:true,name:'unknown',target:'other_bot',args:'words',registered:false});
});

test('command-like text never becomes agent input and private unknown commands reply',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-command-like-'));const sent=[];let receive;
  const bridge=new ChatBridge({dataDir,bindings:[],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['owner']}]},{
    agent,adapterFactory:async()=>({capabilities:{edit:false},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log});
  try{
    await bridge.start();
    await receive({id:'unknown',chatId:'dm',userId:'owner',kind:'dm',text:'/missing'});
    await receive({id:'group',chatId:'group',userId:'owner',kind:'group',mentioned:true,text:'/missing'});
    await receive({id:'removed',chatId:'dm',userId:'owner',kind:'dm',text:'/session'});
    await bridge.flush();
    assert.deepEqual(sent,[{text:'Unknown command. Send /help to see available commands.',replyTo:'unknown',target:{chatId:'dm',kind:'dm',userId:'owner',messageId:'unknown'}}]);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('authorized commands bypass chat lists and remain durable while unauthorized callers cannot run them',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-command-admission-'));const sent=[];let receive,runs=0;
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','ping.mjs'),`export default {name:'ping',description:'Ping',run:async()=>({text:'pong'})};`);
  const bridge=new ChatBridge({dataDir,bindings:[],adapters:[{id:'d',type:'discord',dmOnly:true,allowUsers:['owner'],allowChats:['allowed'],denyChats:['blocked']}]},{
    agent,adapterFactory:async()=>({capabilities:{edit:false},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log});
  try{
    await bridge.start();
    const command=bridge.commands.find(item=>item.name==='ping'),run=command.run;command.run=async context=>{runs++;return run(context);};
    const message={id:'same',chatId:'blocked',userId:'owner',kind:'group',mentioned:false,text:'/ping'};
    await receive(message);await receive(message);
    await receive({...message,id:'denied',userId:'stranger'});
    await bridge.flush();
    assert.equal(runs,1);assert.equal(sent[0].text,'pong');assert.equal(sent[0].replyTo,'same');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('private command extensions stay hidden in group help',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-command-help-'));const sent=[];let receive;
  mkdirSync(join(dataDir,'commands'));writeFileSync(join(dataDir,'commands','secret.mjs'),`export default {name:'secret',description:'Private',privateOnly:true,run:async()=>({text:'ok'})};`);
  const bridge=new ChatBridge({dataDir,bindings:[],adapters:[{id:'d',type:'discord',dmOnly:false,allowUsers:['owner']}]},{
    agent,adapterFactory:async()=>({capabilities:{edit:false},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return{id:String(sent.length)};}}),log});
  try{
    await bridge.start();await receive({id:'help',chatId:'group',userId:'owner',kind:'group',mentioned:false,text:'/help'});await bridge.flush();
    assert.match(sent[0].text,/\/help/);assert.doesNotMatch(sent[0].text,/\/secret/);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});
