import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatBridge} from '../src/chat/bridge.mjs';
import {createAdapter,normalizeDiscordMessage} from '../src/chat/adapters/discord.mjs';

test('Discord clears guild overrides and executes admitted group usage through the attention bridge',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-group-command-'));const menus=[],edits=[];let observed=0,reads=0;
  const client=new EventEmitter();Object.assign(client,{user:{id:'bot'},login:async()=>{},isReady:()=>true,destroy:async()=>{},
    application:{commands:{set:async(commands,guildId)=>menus.push({commands,guildId})}},
    guilds:{cache:new Map([['cached',{}]]),fetch:async()=>new Map([['current',{}]])}});
  const config={dataDir,bindings:[],adapters:[{id:'d',type:'discord',token:'test',allowUsers:['allowed'],dmOnly:true,commandChatIds:['channel'],__client:client}]};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{}},adapterFactory:createAdapter,
    log:{info(){},warn(){},error(){}},usage:async()=>{reads++;return{text:'Usage result'};}});
  bridge.attention={observe:()=>{observed++;},flush:async()=>{},stop(){}};
  try{
    await bridge.start();
    assert.equal(normalizeDiscordMessage({id:'normal',guildId:'current',channelId:'channel',content:'normal chat',author:{id:'allowed'},mentions:{users:{has:()=>true}}},config.adapters[0],'bot'),null);
    assert.deepEqual(menus.map(x=>[x.guildId,x.commands.map(c=>c.name)]),[[undefined,['help','usage']],['cached',[]],['current',[]]]);
    const interaction={id:'group-command',channelId:'channel',guildId:'current',user:{id:'allowed'},commandName:'usage',isChatInputCommand:()=>true,
      options:{getString:()=> 'text'},deferReply:async()=>{},editReply:async output=>{edits.push(output);return{id:'reply'};}};
    client.emit('interactionCreate',interaction);await new Promise(resolve=>setImmediate(resolve));await bridge.flush();
    assert.equal(reads,1);assert.equal(observed,0);assert.equal(edits[0].content,'Usage result');
    client.emit('interactionCreate',{...interaction,id:'denied',user:{id:'stranger'}});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
    client.emit('interactionCreate',{...interaction,id:'other-channel',channelId:'other'});await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});
