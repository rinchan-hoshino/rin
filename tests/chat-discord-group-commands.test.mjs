import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../dist/chat/bridge.js';
import {createAdapter,normalizeDiscordMessage} from '../dist/chat/adapters/discord.js';

test('Discord clears guild overrides and executes admitted group help through the bridge',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-group-command-'));const menus=[],edits=[];let observed=0;
  const client=new EventEmitter();Object.assign(client,{user:{id:'bot'},login:async()=>{},isReady:()=>true,destroy:async()=>{},
    application:{commands:{set:async(commands,guildId)=>menus.push({commands,guildId})}},
    guilds:{cache:new Map([['cached',{}]]),fetch:async()=>new Map([['current',{}]])}});
  const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',token:'test',allowUsers:['allowed'],dmOnly:true,__client:client}]};
  const bridge=new ChatBridge(config,{agent:{start:async()=>{},stop:async()=>{}},adapterFactory:createAdapter,
    log:{info(){},warn(){},error(){}}});
  bridge.attention={observe:()=>{observed++;},flush:async()=>{},stop(){}};
  try{
    await bridge.start();
    assert.equal(normalizeDiscordMessage({id:'normal',guildId:'current',channelId:'channel',content:'normal chat',author:{id:'allowed'},mentions:{users:{has:()=>true}}},config.adapters[0],'bot'),null);
    assert.deepEqual(menus.map(x=>[x.guildId,x.commands.map(c=>c.name)]),[[undefined,['help']],['cached',[]],['current',[]]]);
    const interaction={id:'group-command',channelId:'channel',guildId:'current',user:{id:'allowed'},commandName:'help',isChatInputCommand:()=>true,
      options:{getString:()=> null},deferReply:async()=>{},editReply:async output=>{edits.push(output);return{id:'reply'};}};
    client.emit('interactionCreate',interaction);await new Promise(resolve=>setImmediate(resolve));await bridge.flush();
    assert.equal(observed,0);assert.match(edits[0].content,/\/help/);
    client.emit('interactionCreate',{...interaction,id:'denied',user:{id:'stranger'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(edits.length,1);
    client.emit('interactionCreate',{...interaction,id:'other-channel',channelId:'other'});await new Promise(resolve=>setImmediate(resolve));assert.equal(observed,0);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('Discord group text commands retain addressing and recognize extension registry',()=>{
  const config={allowUsers:['allowed'],dmOnly:true};
  const message={id:'text',guildId:'guild',channelId:'any-channel',author:{id:'allowed'},content:'<@bot> /ping',mentions:{users:{has:()=>true}}};
  const commands=[{name:'ping',description:'Extension'}];
  assert.equal(normalizeDiscordMessage(message,config,'bot',commands)?.text,'/ping');
  assert.equal(normalizeDiscordMessage({...message,content:'/ping',mentions:{users:{has:()=>false}}},config,'bot',commands)?.text,'/ping');
  const selfTarget=normalizeDiscordMessage({...message,content:'/ping@RinBot',mentions:{users:{has:()=>false}}},config,{id:'bot',username:'RinBot'},commands);
  assert.equal(selfTarget?.commandTarget,'self');
  const otherTarget=normalizeDiscordMessage({...message,guildId:undefined,content:'/ping@OtherBot'},config,{id:'bot',username:'RinBot'},commands);
  assert.equal(otherTarget?.commandTarget,'other');
  assert.equal(normalizeDiscordMessage({...message,content:'ordinary chat',mentions:{users:{has:()=>false}}},config,'bot',commands),null);
  assert.equal(normalizeDiscordMessage({...message,content:'<@bot> /unknown'},config,'bot',commands),null);
  assert.equal(normalizeDiscordMessage({...message,mentions:{users:{has:()=>false}}},config,'bot',commands),null);
  assert.equal(normalizeDiscordMessage({...message,author:{id:'stranger'}},config,'bot',commands),null);
});
