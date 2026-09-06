import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAdapter as discordAdapter, normalizeDiscordMessage} from '../src/chat/adapters/discord.mjs';
import {createAdapter as telegramAdapter, normalizeTelegramUpdate} from '../src/chat/adapters/telegram.mjs';

test('Discord rejects bots, guild messages by default, and users outside the allowlist', () => {
  const base = {id: '1', channelId: 'c', content: 'hello', attachments: new Map(), author: {id: 'allowed'}};
  assert.equal(normalizeDiscordMessage({...base, author: {id: 'allowed', bot: true}}, {allowUsers: ['allowed']}), null);
  assert.equal(normalizeDiscordMessage({...base, guildId: 'g'}, {allowUsers: ['allowed']}), null);
  assert.equal(normalizeDiscordMessage({...base, guildId: 'g'}, {allowUsers: ['allowed'], dmOnly: false}, 'bot'), null);
  assert.equal(normalizeDiscordMessage({...base, guildId: 'g', mentions: {users: {has: () => true}}}, {allowUsers: ['allowed'], dmOnly: false}, 'bot').kind, 'group');
  assert.equal(normalizeDiscordMessage({...base, author: {id: 'stranger'}}, {allowUsers: ['allowed']}), null);
  assert.equal(normalizeDiscordMessage(base, {allowUsers: ['allowed']}).kind, 'dm');
});

test('Discord applies admission before downloading attachments', async () => {
  const client = new EventEmitter(); client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  let fetched = 0; let delivered = 0;
  const adapter = discordAdapter({token: 'x', allowUsers: ['allowed'], __client: client, __fetch: async () => { fetched++; }},
    {dataDir: '/tmp', log: {error() {}}});
  await adapter.start(async () => { delivered++; });
  client.emit('messageCreate', {id: '1', channelId: 'c', author: {id: 'stranger'}, attachments: new Map([['x', {url: 'https://invalid'}]])});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, 0); assert.equal(delivered, 0);
  await adapter.stop();
});

test('Discord recognized controls never enter attention when group or user admission rejects them', async()=>{
  const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.isReady=()=>true;client.destroy=async()=>{};
  let observed=0,handled=0;
  const adapter=discordAdapter({token:'x',allowUsers:['owner'],dmOnly:true,__client:client},{dataDir:'/tmp',log:{},observeDiscord:async()=>{observed++;}});
  await adapter.start(async()=>{handled++;});
  client.emit('messageCreate',{id:'1',channelId:'g',guildId:'guild',content:'/usage',author:{id:'owner'},attachments:new Map()});
  client.emit('messageCreate',{id:'2',channelId:'dm',content:'/usage',author:{id:'stranger'},attachments:new Map()});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(observed,0);assert.equal(handled,0);
  await adapter.stop();
});

test('Discord registers the shared commands and routes deferred slash commands through the bridge', async () => {
  const registered = []; const received = []; const edits = []; const followups=[]; let defers=0;
  const client = new EventEmitter();
  client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  client.application = {commands: {set: async (...args) => registered.push(args)}};
  client.channels = {fetch: async () => assert.fail('interaction response must not fall back to a public channel')};
  const commands=[{name:'help',description:'Show available commands'},{name:'usage',description:'Show account usage',argument:'Options'}];
  const adapter = discordAdapter({token: 'x', allowUsers: ['allowed'], __client: client}, {
    commands, dataDir: '/tmp', log: {}, isBound: async () => true, isCommand: message => message.text.startsWith('/'),
  });
  await adapter.start(message => received.push(message));
  const interaction = {
    id: 'ix', channelId: 'dm', user: {id: 'allowed'}, commandName: 'usage', guildId: null,
    isChatInputCommand: () => true, options: {getString: name => name === 'args' ? '1234' : null},
    deferReply: async payload => { defers++; assert.deepEqual(payload, {ephemeral: true}); },
    editReply: async payload => { edits.push(payload); return {id: 'response'}; },
    followUp: async payload => followups.push(payload),
  };
  client.emit('interactionCreate', interaction);
  client.emit('interactionCreate', interaction);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0][0].map(command => command.name), ['help','usage']);
  assert.equal(registered[0][0].find(command => command.name === 'usage').options[0].name, 'args');
  assert.deepEqual(received[0], {
    id:'ix', chatId:'dm', userId:'allowed', kind:'dm', mentioned:true, text:'/usage 1234', files:[], commandInteraction:{id:'ix'},
  });
  assert.equal(defers,1); assert.equal(received.length,1);
  assert.deepEqual(await adapter.send({chatId:'dm', commandInteraction:{id:'ix'}}, {text:'x'.repeat(2001)}), {id:'response'});
  assert.equal(edits[0].content.length, 2000);
  assert.deepEqual(followups,[{content:'x',ephemeral:true,allowedMentions:{parse:[],repliedUser:false}}]);
  await assert.rejects(adapter.send({chatId:'dm', commandInteraction:{id:'missing'}}, {text:'no'}), /interaction_unavailable/);
  await adapter.stop();
});

test('Discord registers and routes dynamic commands without exposing their implementation', async () => {
  const registered=[]; const received=[];
  const commands=[{name:'ping',description:'Check latency',argument:'Optional label',run(){throw new Error('must not run');}}];
  const client=new EventEmitter(); client.user={id:'bot'}; client.login=async()=>{}; client.isReady=()=>true; client.destroy=async()=>{};
  client.application={commands:{set:async value=>registered.push(value)}};
  const adapter=discordAdapter({token:'x',allowUsers:['allowed'],__client:client},{commands,dataDir:'/tmp',log:{},isBound:async()=>true});
  await adapter.start(message=>received.push(message));
  assert.deepEqual(registered[0],[{name:'ping',description:'Check latency',type:1,options:[{name:'args',description:'Optional label',type:3,required:false}]}]);
  assert.equal(JSON.stringify(registered[0]).includes('run'),false);
  client.emit('interactionCreate',{id:'dynamic',channelId:'dm',user:{id:'allowed'},commandName:'ping',isChatInputCommand:()=>true,
    options:{getString:()=> 'now'},deferReply:async()=>{},editReply:async()=>({id:'reply'})});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received[0].text,'/ping now');
  await adapter.stop();
});

test('Discord interaction sends only the attachment and uses fallback text only after upload failure', async () => {
  const client=new EventEmitter(); client.user={id:'bot'}; client.login=async()=>{}; client.isReady=()=>true; client.destroy=async()=>{};
  const edits=[]; client.application={commands:{set:async()=>{}}};
  const adapter=discordAdapter({token:'x',allowUsers:['allowed'],__client:client},{dataDir:'/tmp',log:{},isBound:async()=>true});
  await adapter.start(async()=>{});
  client.emit('interactionCreate',{
    id:'file-ix',channelId:'dm',user:{id:'allowed'},commandName:'help',isChatInputCommand:()=>true,options:{getString:()=>null},
    deferReply:async()=>{},editReply:async payload=>{edits.push(payload);if(payload.files?.length)throw new Error('upload');return{id:'response'};},followUp:async()=>{},
  });
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await adapter.send({commandInteraction:{id:'file-ix'}},{text:'',fallbackText:'完整额度文字',files:[{path:'/tmp/a',name:'a'}]}),{id:'response'});
  assert.equal(edits.length,2); assert.equal(edits[0].content,''); assert.ok(edits[0].files?.length);
  assert.deepEqual(edits[1].files,[]); assert.deepEqual(edits[1].attachments,[]); assert.equal(edits[1].content,'完整额度文字');
  await adapter.stop();
});

test('Discord interaction preserves the complete fallback across follow-ups', async () => {
  const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.isReady=()=>true;client.destroy=async()=>{};client.application={commands:{set:async()=>{}}};
  const edits=[],followups=[];const adapter=discordAdapter({token:'x',allowUsers:['allowed'],__client:client},{dataDir:'/tmp',log:{},isBound:async()=>true});
  await adapter.start(async()=>{});
  client.emit('interactionCreate',{id:'long-fallback',channelId:'dm',user:{id:'allowed'},commandName:'help',isChatInputCommand:()=>true,options:{getString:()=>null},deferReply:async()=>{},editReply:async payload=>{edits.push(payload);if(payload.files?.length)throw new Error('upload');return{id:'response'};},followUp:async payload=>followups.push(payload)});
  await new Promise(resolve=>setImmediate(resolve));
  const fallback='额'.repeat(4500);
  await adapter.send({commandInteraction:{id:'long-fallback'}},{fallbackText:fallback,files:[{path:'/tmp/a',name:'a'}]});
  assert.equal(edits[1].content.length,2000);assert.deepEqual(followups.map(value=>value.content.length),[2000,500]);
  assert.equal(edits[1].content+followups.map(value=>value.content).join(''),fallback);
  await adapter.stop();
});

test('Discord command registration failure does not block startup', async () => {
  const warnings=[]; const client = new EventEmitter();
  client.user={id:'bot'}; client.login=async()=>{}; client.isReady=()=>true; client.destroy=async()=>{};
  client.application={commands:{set:async()=>{throw new Error('secret registration detail');}}};
  const adapter=discordAdapter({token:'x',allowUsers:['allowed'],__client:client},{dataDir:'/tmp',log:{warn:value=>warnings.push(value)}});
  await adapter.start(async()=>{});
  assert.deepEqual(warnings,['Discord command registration failed']);
  await adapter.stop();
});

test('Discord applies the core binding gate before downloading attachments', async () => {
  const client = new EventEmitter(); client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  let fetched = 0;
  const adapter = discordAdapter({token: 'x', allowUsers: ['allowed'], __client: client, __fetch: async () => { fetched++; }},
    {dataDir: '/tmp', log: {error() {}}, isBound: async () => false});
  await adapter.start(async () => assert.fail('unbound message was delivered'));
  client.emit('messageCreate', {id: '1', channelId: 'unbound', content: 'file', author: {id: 'allowed'}, attachments: new Map([['x', {url: 'https://invalid'}]])});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, 0);
  await adapter.stop();
});

test('Discord output cannot ping users through text or replies', async () => {
  const client = new EventEmitter(); client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  let payload;
  client.channels = {fetch: async () => ({send: async value => { payload = value; return {id: 'sent'}; }})};
  const adapter = discordAdapter({token: 'x', allowUsers: ['allowed'], __client: client}, {dataDir: '/tmp', log: {error() {}}});
  await adapter.start(async () => {});
  assert.deepEqual(await adapter.send({chatId: 'c'}, {text: '<@123>', replyTo: 'old'}), {id: 'sent'});
  assert.deepEqual(payload.allowedMentions, {parse: [], repliedUser: false});
  await adapter.stop();
});

test('Discord delete treats an already missing message as success', async () => {
  const client = new EventEmitter(); client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  client.channels = {fetch: async () => ({messages: {delete: async () => { const error = new Error('Unknown Message'); error.code = 10008; throw error; }}})};
  const adapter = discordAdapter({token: 'x', allowUsers: ['allowed'], __client: client}, {dataDir: '/tmp', log: {error() {}}});
  await adapter.start(async () => {});
  await adapter.delete({chatId: 'c'}, 'gone');
  await adapter.stop();
});

test('Telegram normalization selects the largest photo and gates before file parsing', () => {
  const denied = normalizeTelegramUpdate({message: {message_id: 1, chat: {id: -1, type: 'group'}, from: {id: 2}, document: {file_id: 'secret'}}}, {allowUsers: ['1'], dmOnly: false});
  assert.equal(denied, null);
  const accepted = normalizeTelegramUpdate({message: {message_id: 2, chat: {id: 3, type: 'private'}, from: {id: 1}, photo: [{file_id: 'small'}, {file_id: 'large'}]}}, {allowUsers: ['1']});
  assert.equal(accepted.descriptor.id, 'large');
  assert.equal(normalizeTelegramUpdate({edited_message: {message_id: 2, chat: {id: 3, type: 'private'}, from: {id: 1}}}, {allowUsers: ['1']}), null);
});

test('Telegram normalizes commands addressed to this bot and rejects commands for another bot', () => {
  const config={allowUsers:['1'],dmOnly:false};
  const message={message_id:2,chat:{id:-3,type:'group'},from:{id:1}};
  assert.equal(normalizeTelegramUpdate({message:{...message,text:'/usage@RinBot current'}},config,{id:'9',username:'rinbot'}).text,'/usage current');
  assert.equal(normalizeTelegramUpdate({message:{...message,text:'/help@OtherBot'}},config,{id:'9',username:'rinbot'}),null);
  assert.equal(normalizeTelegramUpdate({message:{...message,text:'/help'}},config,{id:'9',username:'rinbot'}),null);
  assert.equal(normalizeTelegramUpdate({message:{...message,text:'/help'}},{...config,requireMention:false},{id:'9',username:'rinbot'}).mentioned,false);
});

test('Telegram admits recognized group commands for allowed users under dmOnly', () => {
  const config={allowUsers:['1'],dmOnly:true};
  const base={message_id:2,chat:{id:-3,type:'group'},from:{id:1}};
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'/help@RinBot'}},config,{id:'9',username:'rinbot'}).text,'/help');
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'@RinBot /help',entities:[{type:'mention',offset:0,length:7}]}},config,{id:'9',username:'rinbot'}).text,'/help');
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'/help @RinBot',entities:[{type:'mention',offset:6,length:7}]}},config,{id:'9',username:'rinbot'}).text,'/help');
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'/help@RinBot @RinBot',entities:[{type:'mention',offset:13,length:7}]}},config,{id:'9',username:'rinbot'}).text,'/help');
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'@RinBot /help@OtherBot',entities:[{type:'mention',offset:0,length:7}]}},config,{id:'9',username:'rinbot'}),null);
  assert.equal(normalizeTelegramUpdate({message:{...base,from:{id:2},text:'/help@RinBot'}},config,{id:'9',username:'rinbot'}),null);
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'hello',entities:[{type:'text_mention',offset:0,length:0,user:{id:'9'}}]}},config,{id:'9',username:'rinbot'}),null);
  const extensions=[{name:'ping',description:'Check latency'}];
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'/ping@RinBot'}},config,{id:'9',username:'rinbot'},extensions).text,'/ping');
  assert.equal(normalizeTelegramUpdate({message:{...base,text:'/help@RinBot'}},config,{id:'9',username:'rinbot'},extensions),null);
});

test('Telegram clears legacy narrow scopes and authoritatively updates the default command menu', async () => {
  const calls=[]; const deleted=[]; let updates=0;
  const api={raw:{
    deleteWebhook:async()=>true,getMe:async()=>({id:9,username:'rin'}),
    deleteMyCommands:async payload=>deleted.push(payload),
    getMyCommands:async()=>[],setMyCommands:async payload=>calls.push(payload),
    getUpdates:async(_payload,signal)=>updates++ ? await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})) : [],
  }};
  const commands=[{name:'help',description:'Show available commands'},{name:'usage',description:'Show account usage'}];
  const adapter=telegramAdapter({id:'main',token:'x',allowUsers:['1'],__api:api},{commands,dataDir:'/tmp',log:{},getCursor:async()=>0,setCursor:async()=>{}});
  await adapter.start(async()=>{});
  assert.deepEqual(deleted.map(value=>value.scope.type),['all_private_chats','all_group_chats','all_chat_administrators']);
  assert.deepEqual(calls[0],{commands:[{command:'help',description:'Show available commands'},{command:'usage',description:'Show account usage'}],scope:{type:'default'}});
  await adapter.stop();

  const failing={raw:{...api.raw,deleteMyCommands:async()=>{throw new Error('secret');}}};
  const warnings=[];
  const degraded=telegramAdapter({id:'degraded',token:'x',allowUsers:['1'],__api:failing},{dataDir:'/tmp',log:{warn:value=>warnings.push(value)},getCursor:async()=>0,setCursor:async()=>{}});
  await degraded.start(async()=>{});
  assert.deepEqual(warnings,['Telegram command registration failed']);
  await degraded.stop();
});

test('Telegram uses dynamic commands for its menu and addressed-command normalization', async () => {
  const calls=[]; const commands=[{name:'ping',description:'Check latency',run(){throw new Error('must not run');}}];
  const api={raw:{deleteWebhook:async()=>true,getMe:async()=>({id:9,username:'rinbot'}),getMyCommands:async()=>[],
    deleteMyCommands:async()=>true,setMyCommands:async payload=>calls.push(payload),getUpdates:async(_payload,signal)=>await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}};
  const adapter=telegramAdapter({id:'main',token:'x',allowUsers:['1'],dmOnly:false,__api:api},{commands,dataDir:'/tmp',log:{},getCursor:async()=>0,setCursor:async()=>{}});
  await adapter.start(async()=>{});
  assert.deepEqual(calls,[{commands:[{command:'ping',description:'Check latency'}],scope:{type:'default'}}]);
  assert.equal(JSON.stringify(calls).includes('run'),false);
  const message={message_id:2,chat:{id:-3,type:'group'},from:{id:1},text:'/ping@RinBot now'};
  assert.equal(normalizeTelegramUpdate({message},{allowUsers:['1'],dmOnly:false},{id:'9',username:'rinbot'},commands).text,'/ping now');
  assert.equal(normalizeTelegramUpdate({message:{...message,text:'/help@RinBot'}},{allowUsers:['1'],dmOnly:false},{id:'9',username:'rinbot'},commands)?.text,undefined);
  await adapter.stop();
});

test('Telegram commits its cursor only after durable message acceptance', async () => {
  let updatesCalls = 0; const commits = []; let release;
  const accepted = new Promise(resolve => { release = resolve; });
  const api = {raw: {
    deleteWebhook: async () => true, getMe: async () => ({id: 9, username: 'rin'}),
    getUpdates: async () => updatesCalls++ === 0 ? [{update_id: 41, message: {message_id: 7, text: 'hi', chat: {id: 8, type: 'private'}, from: {id: 1}}}] : new Promise(() => {}),
  }};
  const adapter = telegramAdapter({id: 'main', token: 'x', allowUsers: ['1'], __api: api}, {
    dataDir: '/tmp', log: {}, getCursor: async () => 0, setCursor: async (key, value) => commits.push([key, value]),
  });
  await adapter.start(async () => accepted);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commits, []);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(commits, [['telegram:main:offset', 42]]);
  // The replacement long poll intentionally never resolves, so don't await stop in this unit test.
});

test('Telegram preserves the text message id with files and accepts idempotent edits', async () => {
  const calls = [];
  const api = {raw: {
    deleteWebhook: async () => true, getMe: async () => ({id: 9, username: 'rin'}),
    getUpdates: async (_payload, signal) => await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})),
    sendMessage: async payload => { calls.push(['text', payload]); return {message_id: 10}; },
    sendDocument: async payload => { calls.push(['file', payload]); return {message_id: 11}; },
    editMessageText: async () => { const error = new Error('Bad Request: message is not modified'); error.description = 'Bad Request: message is not modified'; throw error; },
  }};
  const adapter = telegramAdapter({id: 'main', token: 'x', allowUsers: ['1'], __api: api}, {
    dataDir: '/tmp', log: {}, getCursor: async () => 0, setCursor: async () => {},
  });
  await adapter.start(async () => {});
  assert.deepEqual(await adapter.send({chatId: '8'}, {text: 'hello', files: [{path: '/tmp/a'}]}), {id: '10'});
  assert.deepEqual(await adapter.send({chatId: '8'}, {text: 'same', editId: '10'}), {id: '10'});
  await assert.rejects(adapter.send({chatId: '8'}, {text: 'x', editId: '10', files: [{path: '/tmp/a'}]}), /edit_with_files/);
  assert.deepEqual(calls.map(([type]) => type), ['text', 'file']);
  await adapter.stop();
});

test('Telegram binding gate prevents file lookup and missing deletes are benign', async () => {
  let updates = 0; let fileLookups = 0; const commits = [];
  const api = {raw: {
    deleteWebhook: async () => true, getMe: async () => ({id: 9, username: 'rin'}),
    getUpdates: async (_payload, signal) => updates++ === 0
      ? [{update_id: 5, message: {message_id: 6, chat: {id: 8, type: 'private'}, from: {id: 1}, document: {file_id: 'private'}}}]
      : await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})),
    getFile: async () => { fileLookups++; return {file_path: 'x'}; },
    deleteMessage: async () => { const error = new Error('Bad Request: message to delete not found'); error.description = error.message; throw error; },
  }};
  const adapter = telegramAdapter({id: 'main', token: 'x', allowUsers: ['1'], __api: api}, {
    dataDir: '/tmp', log: {}, isBound: async () => false, getCursor: async () => 0, setCursor: async (_key, value) => commits.push(value),
  });
  await adapter.start(async () => assert.fail('unbound message was delivered'));
  for (let i = 0; i < 20 && !commits.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(fileLookups, 0); assert.deepEqual(commits, [6]);
  await adapter.delete({chatId: '8'}, '99');
  await adapter.stop();
});

async function telegramFixture(methods = {}) {
  const api = {raw: {
    deleteWebhook: async () => true, getMe: async () => ({id: 9, username: 'rin'}),
    getUpdates: async (_payload, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true})),
    ...methods,
  }};
  const adapter = telegramAdapter({id: 'main', token: 'x', allowUsers: ['1'], __api: api},
    {dataDir: '/tmp', log: {}, getCursor: async () => 0, setCursor: async () => {}});
  await adapter.start(async () => {});
  return adapter;
}

test('Telegram sends and edits HTML, falls back only on entity errors and keeps reply context', async () => {
  const calls = [];
  const adapter = await telegramFixture({
    sendMessage: async payload => { calls.push(payload); if (payload.parse_mode) throw new Error("Bad Request: can't parse entities"); return {message_id: 20}; },
    editMessageText: async payload => { calls.push(payload); return true; },
  });
  assert.deepEqual(await adapter.send({chatId: '8'}, {text: '<b>Hello</b> &amp; hi', parseMode: 'HTML', replyTo: '7'}), {id: '20'});
  assert.equal(calls[0].parse_mode, 'HTML'); assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].text, 'Hello & hi'); assert.equal(calls[1].reply_parameters.message_id, 7);
  assert.deepEqual(await adapter.send({chatId: '8'}, {text: '<i>Edit</i>', parseMode: 'HTML', editId: '20'}), {id: '20'});
  assert.equal(calls[2].parse_mode, 'HTML');
  await adapter.stop();
});

test('Telegram recovers only confirmed uneditable messages and flags uncertain replacement sends', async () => {
  let mode = 'gone'; let sends = 0;
  const adapter = await telegramFixture({
    editMessageText: async () => { throw new Error(mode === 'gone' ? 'Bad Request: message to edit not found' : 'network timeout'); },
    sendMessage: async () => { sends++; if (sends === 2) throw new Error('network timeout'); return {message_id: 21}; },
  });
  assert.deepEqual(await adapter.send({chatId: '8'}, {text: 'new', editId: '20'}), {id: '21'});
  await assert.rejects(adapter.send({chatId: '8'}, {text: 'new', editId: '20'}), error => error.deliveryUncertain === true);
  mode = 'unknown';
  await assert.rejects(adapter.send({chatId: '8'}, {text: '<b>new</b>', parseMode: 'HTML', editId: '20'}), /network timeout/);
  assert.equal(sends, 2);
  await adapter.stop();
});

test('Telegram selects native media APIs and safely falls back for rejected photo dimensions', async () => {
  const calls = []; const methods = {};
  for (const field of ['photo', 'video', 'audio', 'voice', 'animation', 'document']) {
    methods[`send${field[0].toUpperCase()}${field.slice(1)}`] = async payload => {
      calls.push([field, payload]);
      if (field === 'photo' && payload.photo === '/tmp/wide') throw new Error('PHOTO_INVALID_DIMENSIONS');
      return {message_id: calls.length};
    };
  }
  const adapter = await telegramFixture(methods);
  for (const [mimeType, path] of [['image/png','/tmp/image'], ['image/gif','/tmp/gif'], ['video/mp4','/tmp/video'], ['audio/mpeg','/tmp/audio'], ['audio/ogg','/tmp/voice'], ['application/pdf','/tmp/doc'], ['image/png','/tmp/wide']]) {
    await adapter.send({chatId: '8'}, {files: [{path, mimeType}], replyTo: '7'});
  }
  assert.deepEqual(calls.map(([field]) => field), ['photo','animation','video','audio','voice','document','photo','document']);
  assert.ok(calls.every(([,payload]) => payload.reply_parameters.message_id === 7));
  await adapter.stop();
});

test('Discord missing edit resends with reply and no ping but unknown failures do not resend', async () => {
  const client = new EventEmitter(); client.user = {id: 'bot'}; client.login = async () => {}; client.isReady = () => true; client.destroy = async () => {};
  let mode = 'gone'; const sent = [];
  client.channels = {fetch: async () => ({messages: {fetch: async () => {
    const error = new Error(mode); if (mode === 'gone') error.code = 10008; throw error;
  }}, send: async payload => { sent.push(payload); if (sent.length === 2) throw new Error('network timeout'); return {id: 'new'}; }})};
  const adapter = discordAdapter({token: 'x', allowUsers: ['1'], __client: client}, {dataDir: '/tmp', log: {}});
  await adapter.start(async () => {});
  assert.deepEqual(await adapter.send({chatId: 'c'}, {text: 'updated', editId: 'gone', replyTo: 'original'}), {id: 'new'});
  assert.deepEqual(sent[0].reply, {messageReference: 'original', failIfNotExists: false});
  assert.deepEqual(sent[0].allowedMentions, {parse: [], repliedUser: false});
  await assert.rejects(adapter.send({chatId: 'c'}, {text: 'updated', editId: 'gone'}), error => error.deliveryUncertain === true);
  mode = 'timeout';
  await assert.rejects(adapter.send({chatId: 'c'}, {text: 'updated', editId: 'gone'}), /timeout/);
  assert.equal(sent.length, 2);
  await adapter.stop();
});

test('Discord attention observes unbound humans across guilds without broadening direct admission', async () => {
  const client=new EventEmitter();client.user={id:'bot'};client.login=async()=>{};client.isReady=()=>true;client.destroy=async()=>{};
  const observed=[];let delivered=0;
  const adapter=discordAdapter({id:'discord',token:'x',allowUsers:['owner'],__client:client},{dataDir:'/tmp',log:{error:assert.fail},isBound:()=>false,observeDiscord:r=>observed.push(r)});
  await adapter.start(async()=>{delivered++;});
  const base={id:'1',channelId:'thread',guildId:'guild',content:'ambient',author:{id:'stranger',username:'Person'},channel:{parentId:'channel',parent:{parentId:'mirror-category'}},createdTimestamp:1000,attachments:new Map(),reference:{messageId:'previous'}};
  client.emit('messageCreate',base);
  client.emit('messageCreate',{...base,id:'2',author:{id:'another-bot',bot:true}});
  client.emit('messageCreate',{...base,id:'3',author:{id:'bot'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered,0);assert.equal(observed.length,1);
  assert.equal(observed[0].disposition,'record_only');assert.equal(observed[0].userId,'stranger');
  assert.deepEqual(observed[0].ancestorIds,['channel','mirror-category']);assert.equal(observed[0].replyTo,'previous');
  await adapter.stop();
});
