import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { createAdapter as createQQ } from '../dist/chat/adapters/qqbot.js';
import { createAdapter as createOneBot } from '../dist/chat/adapters/onebot.js';

async function context() {
  return { dataDir: await mkdtemp(path.join(tmpdir(), 'rin-chat-')), log: {}, getCursor() {}, setCursor() {} };
}

class FakeQQBot extends EventEmitter {
  constructor(options) { super(); this.options = options; FakeQQBot.instance = this; }
  async start() {}
  stop() {}
  async sendText(target, text) { this.sent = { target, text }; return { id: 'qq-sent' }; }
  async sendFile(target, source, options) { this.file = { target, source, options }; return { id: 'qq-file' }; }
  async sendTyping(target) { this.typed = target; }
}

test('QQ official uses current SDK target shape and gates before attachment download', async () => {
  let fetches = 0;
  const adapter = createQQ({ id: 'qq', appId: 'a', appSecret: 's', allowUsers: ['owner'], dmOnly: true, sdk: { QQBot: FakeQQBot }, fetch: async () => { fetches++; throw new Error('must not fetch'); } }, await context());
  const incoming = [];
  await adapter.start((event) => incoming.push(event));
  await FakeQQBot.instance.emit('message', {}, { kind: 'c2c', senderId: 'stranger', messageId: '1', content: 'x', attachments: [{ url: 'https://invalid/file' }] });
  assert.equal(fetches, 0);
  FakeQQBot.instance.emit('message', {}, { kind: 'c2c', senderId: 'owner', messageId: '2', content: 'hello', rawEventType: 'C2C_MESSAGE_CREATE' });
  await new Promise(setImmediate);
  assert.equal(incoming[0].kind, 'dm');
  assert.equal(incoming[0].chatId, 'owner');
  assert.deepEqual(await adapter.send({ chatId: 'owner', userId: 'owner', kind: 'dm', messageId: '2' }, { text: 'hi' }), { id: 'qq-sent' });
  assert.deepEqual(FakeQQBot.instance.sent.target, { scope: 'c2c', targetId: 'owner', msgId: '2' });
  await adapter.typing({ chatId: 'owner', kind: 'dm' });
  assert.equal(FakeQQBot.instance.typed.scope, 'c2c');
  await assert.rejects(() => adapter.send({ chatId: 'owner', kind: 'dm' }, { text: 'edit', editId: 'x' }), /does not support editing/);
  await adapter.stop();
});

test('QQ official accepts the installed SDK 1.0 message callback fixture', async () => {
  const bot = new QQBot({ appId: 'fixture-app', appSecret: 'fixture-secret', tokenPrefetch: 'async' });
  bot.start = async () => {};
  const adapter = createQQ({ id: 'qq-real-shape', appId: 'a', appSecret: 's', allowUsers: ['owner'], dmOnly: true, sdk: { QQBot }, bot }, await context());
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  await bot.handleInboundMessage({ rawEventType: 'C2C_MESSAGE_CREATE', kind: 'c2c', senderId: 'owner', content: 'fixture', messageId: 'sdk-event', timestamp: new Date().toISOString(), raw: {} });
  assert.equal(incoming[0].id, 'sdk-event');
  assert.equal(incoming[0].text, 'fixture');
  await adapter.stop();
});

test('QQ official admits only recognized group commands through dmOnly', async () => {
  const ctx=await context();ctx.commands=[{name:'ping',description:'Check latency'}];
  const adapter = createQQ({id:'qq-command',appId:'a',appSecret:'s',allowUsers:['owner'],dmOnly:true,requireMention:false,sdk:{QQBot:FakeQQBot}},ctx);
  const incoming=[];
  await adapter.start(async event=>incoming.push(event));
  FakeQQBot.instance.emit('message',{}, {kind:'group',senderId:'owner',groupOpenid:'g',messageId:'1',content:'/ping'});
  FakeQQBot.instance.emit('message',{}, {kind:'group',senderId:'stranger',groupOpenid:'g',messageId:'2',content:'/ping'});
  FakeQQBot.instance.emit('message',{}, {kind:'group',senderId:'owner',groupOpenid:'g',messageId:'3',content:'/help'});
  await new Promise(setImmediate);
  assert.deepEqual(incoming.map(event=>event.id),['1']);
  await adapter.stop();
});

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; FakeWebSocket.instance = this; }
  send(value, callback) { this.last = JSON.parse(value); callback?.(); }
  close() { this.readyState = 3; }
}

test('OneBot v11 parses segments, authorizes before downloads, and correlates RPC echo', async () => {
  let fetches = 0;
  const adapter = createOneBot({ id: 'ob', wsUrl: 'ws://onebot', token: 'secret', allowUsers: ['42'], dmOnly: false, WebSocket: FakeWebSocket, fetch: async () => { fetches++; throw new Error('must not fetch'); } }, await context());
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  FakeWebSocket.instance.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 7, message_id: 1, message: [{ type: 'file', data: { url: 'https://invalid' } }] }));
  await new Promise(setImmediate);
  assert.equal(fetches, 0);
  FakeWebSocket.instance.emit('message', JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 99, user_id: 42, group_id: 8, message_id: 2, message: [{ type: 'reply', data: { id: 'old' } }, { type: 'at', data: { qq: '99' } }, { type: 'text', data: { text: ' hello ' } }] }));
  await new Promise(setImmediate);
  assert.deepEqual(incoming[0], { id: '2', chatId: '8', userId: '42', kind: 'group', mentioned: true, text: 'hello', files: [], replyTo: 'old' });
  const sending = adapter.send({ chatId: '8', kind: 'group' }, { text: 'answer', replyTo: '2' });
  assert.equal(FakeWebSocket.instance.last.action, 'send_group_msg');
  assert.deepEqual(FakeWebSocket.instance.last.params.message[0], { type: 'reply', data: { id: '2' } });
  FakeWebSocket.instance.emit('message', JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9 }, echo: FakeWebSocket.instance.last.echo }));
  assert.deepEqual(await sending, { id: '9' });
  await adapter.stop();
});

test('OneBot keeps mixed rich segments in provider order after admission', async () => {
  const incoming=[];
  const adapter=createOneBot({id:'ob-order',wsUrl:'ws://onebot',allowUsers:['42'],dmOnly:false,WebSocket:FakeWebSocket,
    fetch:async()=>new Response('image-bytes')},await context());
  await adapter.start(async event=>incoming.push(event));
  FakeWebSocket.instance.emit('message',JSON.stringify({post_type:'message',message_type:'group',self_id:99,user_id:42,group_id:8,message_id:3,message:[
    {type:'at',data:{qq:'99'}},{type:'text',data:{text:'A'}},{type:'image',data:{url:'https://cdn.example/a.png',name:'a.png'}},{type:'text',data:{text:'B'}},
    {type:'at',data:{qq:'7'}},{type:'face',data:{id:'5'}},{type:'at',data:{qq:'99'}},{type:'text',data:{text:'C'}},
  ]}));
  for(let i=0;i<40 && !incoming.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.match(incoming[0].text,/^A\[image: .*a\.png\]B\[@7\]\[sticker: face-6; unavailable: no downloadable URL\]C$/);
  assert.equal(incoming[0].files.length,1);
  await adapter.stop();
});

test('OneBot HTTP sends to the v11 action endpoint with bearer auth', async () => {
  const calls = [];
  const adapter = createOneBot({ id: 'ob', wsUrl: 'ws://onebot', httpUrl: 'http://api/', token: 't', allowUsers: ['42'], dmOnly: true, WebSocket: FakeWebSocket, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 3 } }) }; } }, await context());
  await adapter.start(async () => {});
  assert.deepEqual(await adapter.send({ chatId: '42', userId: '42', kind: 'dm' }, { text: 'x' }), { id: '3' });
  assert.equal(calls[0].url, 'http://api/send_private_msg');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
  await adapter.delete({ chatId: '42', kind: 'dm' }, '3');
  assert.equal(calls[1].url, 'http://api/delete_msg');
  assert.deepEqual(JSON.parse(calls[1].init.body), { message_id: '3' });
  await assert.rejects(() => adapter.typing({ chatId: '42', kind: 'dm' }), /does not define typing/);
  await adapter.stop();
});

test('OneBot admits registered bare and @ commands with the default mention gate', async () => {
  const ctx=await context();ctx.commands=[{name:'ping',description:'Check latency'}];
  const adapter=createOneBot({id:'ob-command',wsUrl:'ws://onebot',allowUsers:['42'],dmOnly:true,WebSocket:FakeWebSocket},ctx);
  const incoming=[];
  await adapter.start(async event=>incoming.push(event));
  for(const event of [
    {user_id:42,message_id:1,message:'/ping'},
    {user_id:42,message_id:2,message:[{type:'at',data:{qq:99}},{type:'text',data:{text:' /ping'}}],self_id:99},
    {user_id:42,message_id:3,message:'/ping@99',self_id:99},
    {user_id:42,message_id:4,message:'ordinary chat'},
    {user_id:42,message_id:5,message:'/unknown'},
    {user_id:7,message_id:6,message:'/ping'},
    {user_id:42,message_id:7,message:'/help'},
  ]) FakeWebSocket.instance.emit('message',JSON.stringify({post_type:'message',message_type:'group',group_id:8,...event}));
  await new Promise(setImmediate);
  assert.deepEqual(incoming.map(event=>event.id),['1','2','3']);
  assert.equal(incoming[1].mentioned,true);
  assert.equal(incoming[2].commandTarget,'self');
  await adapter.stop();
});

test('OneBot marks a complete owner-and-self member list private-like', async () => {
  const adapter=createOneBot({id:'ob-private-like',wsUrl:'ws://onebot',allowUsers:['42'],ownerUsers:['42'],dmOnly:true,WebSocket:FakeWebSocket},await context());
  const incoming=[];
  await adapter.start(async event=>incoming.push(event));
  FakeWebSocket.instance.emit('message',JSON.stringify({post_type:'message',message_type:'group',group_id:8,self_id:99,user_id:42,message_id:1,message:'bare'}));
  await new Promise(setImmediate);
  assert.equal(FakeWebSocket.instance.last.action,'get_group_member_list');
  FakeWebSocket.instance.emit('message',JSON.stringify({status:'ok',retcode:0,echo:FakeWebSocket.instance.last.echo,data:[{user_id:42},{user_id:99}]}));
  await new Promise(setImmediate);
  assert.equal(incoming.length,1);
  assert.equal(incoming[0].kind,'group');
  assert.equal(incoming[0].privateLike,true);
  await adapter.stop();
});

test('OneBot treats CQ-looking string messages as plain text', async () => {
  const adapter = createOneBot({ id: 'ob-cq', wsUrl: 'ws://onebot', allowUsers: ['42'], dmOnly: true, WebSocket: FakeWebSocket }, await context());
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  FakeWebSocket.instance.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 42, message_id: 7, message: '[CQ:at,qq=99] hello' }));
  await new Promise(setImmediate);
  assert.equal(incoming[0].text, '[CQ:at,qq=99] hello');
  assert.equal(incoming[0].mentioned, false);
  await adapter.stop();
});

test('OneBot never forwards its gateway token to attachment URLs', async () => {
  const requests = [];
  const adapter = createOneBot({
    id: 'ob-media', wsUrl: 'ws://onebot', token: 'gateway-secret', allowUsers: ['42'], dmOnly: true, WebSocket: FakeWebSocket,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, headers: { get: () => '2' }, arrayBuffer: async () => Buffer.from('ok') };
    },
  }, await context());
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  FakeWebSocket.instance.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 42, message_id: 8, message: [{ type: 'image', data: { url: 'https://cdn.example.test/private.jpg' } }] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://cdn.example.test/private.jpg');
  assert.equal(requests[0].init.headers, undefined);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(incoming.length, 1);
  await adapter.stop();
});

test('all enabled adapters reject an empty allowlist before creating transports', async () => {
  const ctx = await context();
  assert.throws(() => createQQ({ appId: 'a', appSecret: 's', allowUsers: [] }, ctx), /non-empty allowUsers/);
  assert.throws(() => createOneBot({ wsUrl: 'ws://x', allowUsers: [] }, ctx), /non-empty allowUsers/);
});

test('all adapters check binding before attachment download', async () => {
  let qqFetches = 0;
  const unboundQQContext = { ...(await context()), isBound: async () => false };
  const qq = createQQ({ id: 'qq-unbound', appId: 'a', appSecret: 's', allowUsers: ['owner'], dmOnly: true, sdk: { QQBot: FakeQQBot }, fetch: async () => { qqFetches++; throw new Error('must not fetch'); } }, unboundQQContext);
  await qq.start(async () => assert.fail('unbound QQ message reached callback'));
  FakeQQBot.instance.emit('message', {}, { kind: 'c2c', senderId: 'owner', messageId: 'q', content: '', attachments: [{ url: 'https://cdn.test/q' }] });
  await new Promise(setImmediate);
  assert.equal(qqFetches, 0);
  await qq.stop();

  let obFetches = 0;
  const ob = createOneBot({ id: 'ob-unbound', wsUrl: 'ws://onebot', allowUsers: ['42'], dmOnly: true, WebSocket: FakeWebSocket, fetch: async () => { obFetches++; throw new Error('must not fetch'); } }, { ...(await context()), isBound: async () => false });
  await ob.start(async () => assert.fail('unbound OneBot message reached callback'));
  FakeWebSocket.instance.emit('message', JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 42, message_id: 9, message: [{ type: 'image', data: { url: 'https://cdn.test/o' } }] }));
  await new Promise(setImmediate);
  assert.equal(obFetches, 0);
  await ob.stop();

});

test('OneBot media uses portable base64 with image/record/video and standalone file upload',async()=>{
  const {writeFile}=await import('node:fs/promises');const ctx=await context();const filePath=path.join(ctx.dataDir,'media');await writeFile(filePath,'bytes');
  const calls=[];
  const adapter=createOneBot({id:'media',wsUrl:'ws://onebot',httpUrl:'http://api/',allowUsers:['42'],WebSocket:FakeWebSocket,
    fetch:async(url,init)=>{calls.push({url,payload:JSON.parse(init.body)});return {ok:true,json:async()=>({status:'ok',retcode:0,data:{message_id:'sent',file_id:'uploaded'}})};},
  },ctx);
  await adapter.start(async()=>{});
  try{
    for(const [mimeType,type] of [['image/png','image'],['audio/ogg','record'],['video/mp4','video']]){
      await adapter.send({chatId:'42',kind:'dm'},{replyTo:'quote',files:[{path:filePath,mimeType}]});
      assert.deepEqual(calls.at(-1).payload.message,[{type:'reply',data:{id:'quote'}},{type,data:{file:'base64://Ynl0ZXM='}}]);
    }
    assert.deepEqual(await adapter.send({chatId:'group',kind:'group'},{files:[{path:filePath,name:'report.pdf',mimeType:'application/pdf'}]}),{id:'uploaded'});
    assert.equal(calls.at(-1).url,'http://api/upload_group_file');assert.equal(calls.at(-1).payload.file,'base64://Ynl0ZXM=');assert.equal(calls.at(-1).payload.name,'report.pdf');
  }finally{await adapter.stop();}
});
