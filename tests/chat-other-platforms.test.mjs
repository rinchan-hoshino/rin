import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { createAdapter as createQQ } from '../src/chat/adapters/qqbot.mjs';
import { createAdapter as createOneBot } from '../src/chat/adapters/onebot.mjs';
import { createAdapter as createFeishu } from '../src/chat/adapters/feishu.mjs';

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

class FakeDispatcher {
  register(map) { this.map = map; FakeDispatcher.instance = this; return this; }
}
class FakeWSClient {
  async start(options) { this.options = options; FakeWSClient.instance = this; }
  async close() {}
}

test('Feishu long connection gates resources and uses official message endpoints', async () => {
  let resources = 0;
  const calls = [];
  const client = { im: {
    messageResource: { get: async () => { resources++; return { headers: { 'content-length': '1' }, getReadableStream: () => Readable.from([Buffer.from('x')]) }; } },
    message: {
      create: async (request) => { calls.push(['create', request]); return { data: { message_id: 'fs-1' } }; },
      reply: async (request) => { calls.push(['reply', request]); return { data: { message_id: 'fs-reply' } }; },
      update: async (request) => { calls.push(['update', request]); return { data: { message_id: 'fs-edit' } }; },
      delete: async (request) => { calls.push(['delete', request]); },
    },
    image: { create: async () => ({ data: { image_key: 'img' } }) },
    file: { create: async () => ({ data: { file_key: 'file' } }) },
  } };
  const sdk = { Client: class {}, EventDispatcher: FakeDispatcher, WSClient: FakeWSClient, AppType: {}, Domain: {}, LoggerLevel: {} };
  const adapter = createFeishu({ id: 'fs', appId: 'a', appSecret: 's', allowUsers: ['owner'], dmOnly: true, sdk, client }, await context());
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  await FakeDispatcher.instance.map['im.message.receive_v1']({ sender: { sender_id: { open_id: 'stranger' } }, message: { message_id: 'bad', chat_id: 'c', chat_type: 'p2p', message_type: 'image', content: JSON.stringify({ image_key: 'secret' }) } });
  assert.equal(resources, 0);
  await FakeDispatcher.instance.map['im.message.receive_v1']({ sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'm', chat_id: 'c', chat_type: 'p2p', content: JSON.stringify({ text: 'hello' }) } });
  assert.equal(incoming[0].text, 'hello');
  assert.deepEqual(await adapter.send({ chatId: 'c', userId: 'owner', kind: 'dm' }, { text: 'reply' }), { id: 'fs-1' });
  assert.equal(calls[0][1].params.receive_id_type, 'chat_id');
  assert.equal(calls[0][1].data.receive_id, 'c');
  assert.deepEqual(await adapter.send({ chatId: 'c', kind: 'group' }, { text: 'thread reply', replyTo: 'parent' }), { id: 'fs-reply' });
  assert.equal(calls[1][0], 'reply');
  assert.equal(calls[1][1].path.message_id, 'parent');
  assert.deepEqual(await adapter.send({ chatId: 'c', kind: 'group' }, { text: 'updated', editId: 'old' }), { id: 'fs-edit' });
  assert.equal(calls[2][0], 'update');
  await adapter.delete({ chatId: 'c', kind: 'dm' }, 'fs-edit');
  assert.equal(calls[3][0], 'delete');
  assert.equal(calls[3][1].path.message_id, 'fs-edit');
  await assert.rejects(() => adapter.typing({ chatId: 'c', kind: 'dm' }), /does not support typing/);
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
  assert.throws(() => createFeishu({ appId: 'a', appSecret: 's', allowUsers: [] }, ctx), /non-empty allowUsers/);
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

  let fsDownloads = 0;
  const fsClient = { im: { messageResource: { get: async () => { fsDownloads++; } }, message: {}, image: {}, file: {} } };
  const sdk = { Client: class {}, EventDispatcher: FakeDispatcher, WSClient: FakeWSClient, AppType: {}, Domain: {}, LoggerLevel: {} };
  const fs = createFeishu({ id: 'fs-unbound', appId: 'a', appSecret: 's', allowUsers: ['owner'], dmOnly: true, sdk, client: fsClient }, { ...(await context()), isBound: async () => false });
  await fs.start(async () => assert.fail('unbound Feishu message reached callback'));
  await FakeDispatcher.instance.map['im.message.receive_v1']({ sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'f', chat_id: 'c', chat_type: 'p2p', content: JSON.stringify({ image_key: 'img' }) } });
  assert.equal(fsDownloads, 0);
  await fs.stop();
});

test('Feishu group admission matches only the configured bot mention before downloading', async () => {
  const ctx = await context();
  let downloads = 0;
  const client = { im: {
    messageResource: { get: async () => { downloads++; return { headers: {}, getReadableStream: () => Readable.from([Buffer.from('ok')]) }; } },
    message: {}, image: {}, file: {},
  } };
  const sdk = { Client: class {}, EventDispatcher: FakeDispatcher, WSClient: FakeWSClient, AppType: {}, Domain: {}, LoggerLevel: {} };
  const adapter = createFeishu({ id: 'fs-group', appId: 'a', appSecret: 's', allowUsers: ['owner'], botOpenId: 'bot', sdk, client }, ctx);
  const incoming = [];
  await adapter.start(async (event) => incoming.push(event));
  const fixture = (mentions) => ({ sender: { sender_id: { open_id: 'owner' } }, message: { message_id: 'm/../unsafe', chat_id: 'group', chat_type: 'group', mentions, content: JSON.stringify({ image_key: 'img' }) } });
  await FakeDispatcher.instance.map['im.message.receive_v1'](fixture([{ id: { open_id: 'someone-else' } }]));
  assert.equal(downloads, 0);
  await FakeDispatcher.instance.map['im.message.receive_v1'](fixture([{ id: { open_id: 'bot' } }]));
  assert.equal(downloads, 1);
  assert.equal(incoming.length, 1);
  assert.equal(path.dirname(incoming[0].files[0].path).includes('..'), false);
  await adapter.stop();
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

test('Feishu preserves Markdown post styles on send/edit and media-only quote',async()=>{
  const calls=[];const sdk={Client:class{},EventDispatcher:FakeDispatcher,WSClient:FakeWSClient,AppType:{},Domain:{},LoggerLevel:{}};
  const client={im:{message:{
    create:async request=>{calls.push(['create',request]);return {data:{message_id:'new'}}},
    reply:async request=>{calls.push(['reply',request]);return {data:{message_id:'quoted'}}},
    update:async request=>{calls.push(['update',request]);return {data:{message_id:'old'}}},
  },image:{create:async({data})=>{data.image.destroy();return {data:{image_key:'image'}}}},file:{create:async()=>({data:{file_key:'file'}})}}};
  const ctx=await context();const {writeFile}=await import('node:fs/promises');const local=path.join(ctx.dataDir,'image.png');await writeFile(local,'image');
  const adapter=createFeishu({id:'fs',appId:'a',appSecret:'s',allowUsers:['owner'],sdk,client},ctx);await adapter.start(async()=>{});
  try{
    await adapter.send({chatId:'c',kind:'dm'},{text:'**Bold** and [link](https://example.com)',replyTo:'source'});
    const request=calls[0][1];assert.equal(request.data.msg_type,'post');assert.equal(request.path.message_id,'source');
    assert.deepEqual(JSON.parse(request.data.content).zh_cn.content[0],[{tag:'text',text:'Bold',style:['bold']},{tag:'text',text:' and '},{tag:'a',text:'link',href:'https://example.com'}]);
    await adapter.send({chatId:'c',kind:'dm'},{text:'... Working...\n\n────────\n\n```js\nconst x=1\n```',editId:'old'});
    assert.equal(calls[1][0],'update');assert.equal(calls[1][1].data.msg_type,'post');
    assert.ok(JSON.parse(calls[1][1].data.content).zh_cn.content.flat().some(element=>element.tag==='code_block' && element.language==='js'));
    await adapter.send({chatId:'c',kind:'dm'},{files:[{path:local,mimeType:'image/png'}],replyTo:'source'});
    assert.equal(calls[2][0],'reply');assert.equal(calls[2][1].path.message_id,'source');assert.equal(calls[2][1].data.msg_type,'image');
  }finally{await adapter.stop();}
});

test('Feishu replaces only explicit API missing/uneditable responses, keeps quote and marks uncertain replacement',async()=>{
  const sdk={Client:class{},EventDispatcher:FakeDispatcher,WSClient:FakeWSClient,AppType:{},Domain:{},LoggerLevel:{}};
  let failure={code:230011,msg:'The message is recalled.'}, replacementFailure, sends=0;
  const client={im:{message:{
    update:async()=>{if(failure instanceof Error)throw failure;return failure;},
    reply:async request=>{sends++;assert.equal(request.path.message_id,'source');assert.equal(request.data.msg_type,'post');if(replacementFailure)throw replacementFailure;return {code:0,data:{message_id:'replacement'}};},
    delete:async()=>({code:230011,msg:'The message is recalled.'}),
  }}};
  const adapter=createFeishu({id:'fs',appId:'a',appSecret:'s',allowUsers:['owner'],sdk,client},await context());await adapter.start(async()=>{});
  const send=()=>adapter.send({chatId:'c',kind:'dm'},{text:'progress',editId:'old',replyTo:'source'});
  try{
    assert.deepEqual(await send(),{id:'replacement'});assert.equal(sends,1);
    failure=Object.assign(new Error('request failed'),{response:{data:{code:231003,msg:'message not found'}}});
    assert.deepEqual(await send(),{id:'replacement'});assert.equal(sends,2);
    for(const unknown of [new Error('message not found'),{code:230002,msg:'The bot can not be outside the group.'},{code:230020,msg:'Permission denied'},{code:230001,msg:'Invalid content'}]){
      failure=unknown;await assert.rejects(send);assert.equal(sends,2,'network, permissions and formatting failures cannot create replacement messages');
    }
    failure={code:230011,msg:'The message is recalled.'};replacementFailure=new Error('socket timeout');
    await assert.rejects(send,error=>error.deliveryUncertain===true);assert.equal(sends,3);
    await adapter.delete({chatId:'c'},'already-gone');
  }finally{await adapter.stop();}
});
