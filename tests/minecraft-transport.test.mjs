import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Nerve, Store, makeServer, validateConfig } from '../src/nerve.mjs';
import { MinecraftTransport } from '../src/minecraft-transport.mjs';

const nerveToken = 'nerve-test-token-abcdefghijklmnopqrstuvwxyz';
const minecraftToken = 'minecraft-test-token-abcdefghijklmnopqrstuvwxyz';
const player = '11111111-1111-4111-8111-111111111111';
const maid = '22222222-2222-4222-8222-222222222222';
const inbound = {version:1,id:'m-1',serverId:'private-world',playerUuid:player,maidUuid:maid,conversationId:'conversation',text:'please fetch stone',occurredAt:'2026-09-06T00:00:00.000Z'};

test('Minecraft ingress stays source-locked, durable, private until an explicit canonical game send', async t => {
  const outbox=[]; let acknowledged;
  const game = http.createServer(async (req,res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${minecraftToken}`) { res.writeHead(401).end(); return; }
    let body=''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url,'http://127.0.0.1');
    const reply = value => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && url.pathname === '/v1/inbox') return reply({version:1,messages:acknowledged ? [] : [inbound],nextCursor:'cursor-1'});
    if (req.method === 'POST' && url.pathname === '/v1/inbox/ack') { acknowledged=JSON.parse(body).throughCursor; return reply({ok:true}); }
    if (req.method === 'POST' && url.pathname === '/v1/outbox') { const value=JSON.parse(body); outbox.push(value); return reply({id:value.id,replyTo:value.replyTo,playerUuid:value.playerUuid,maidUuid:value.maidUuid,state:'accepted'}); }
    if (req.method === 'GET' && url.pathname === '/v1/jobs') return reply({version:1,jobs:[{task:{jobId:'j',action:'wait',args:{}},playerUuid:player,maidUuid:maid,status:'running',detail:'3'}]});
    if (req.method === 'GET' && url.pathname === '/v1/inspect') return reply({version:1,player:{uuid:player,name:'owner',dimension:'minecraft:overworld',x:1,y:2,z:3},maid:{uuid:maid,name:'rin',dimension:'minecraft:overworld',x:1,y:2,z:3,inventory:[]},nearbyContainers:[],nearbyBlocks:[],jobs:[]});
    res.writeHead(404).end();
  });
  game.listen(0,'127.0.0.1'); await once(game,'listening');
  t.after(() => game.close());
  const folder = await mkdtemp(join(tmpdir(),'rin-mc-')); t.after(() => rm(folder,{recursive:true,force:true}));
  const config = {targets:{main:{type:'codex',threadId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},minecraft:{endpoint:`http://127.0.0.1:${game.address().port}/`,stateFile:join(folder,'transport.json'),tokenEnv:'MC_BRIDGE_TOKEN',target:'main',source:{serverId:'private-world',playerUuid:player,maidUuid:maid}}};
  const store = new Store(':memory:'); const nerve = new Nerve(config,store,{minecraftSecret:minecraftToken});
  t.after(async () => { await nerve.close(); store.close(); });
  await nerve.open(); await nerve.poll(); await nerve.minecraftSync;
  assert.equal(acknowledged,'cursor-1');
  const event = store.event('minecraft:private-world:m-1');
  assert.equal(event.state,'pending'); assert.equal(event.payload.messageId,'m-1'); assert.equal(JSON.stringify(event.payload).includes(inbound.text),false);
  const api = makeServer(nerve,nerveToken); api.listen(0,'127.0.0.1'); await once(api,'listening'); t.after(() => api.close());
  const base=`http://127.0.0.1:${api.address().port}`;
  const call = (path, method='GET', body) => fetch(base+path,{method,headers:{authorization:`Bearer ${nerveToken}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await (await call('/minecraft/messages/m-1')).json()).text,inbound.text);
  assert.equal((await (await call('/minecraft/messages/m-1/inspect')).json()).maid.uuid,maid);
  const response = await call('/minecraft/send','POST',{id:'once',messageId:'m-1',kind:'task',task:{jobId:'job-1',action:'script',args:{program:JSON.stringify({version:1,steps:[{op:'inspectInventory',item:'minecraft:stone',name:'count'},{op:'branch',kind:'variable',name:'count',value:'1',test:'ge',target:'2'},{op:'use',x:'1',y:'2',z:'3'}]})}}});
  assert.equal((await response.json()).state,'accepted');
  assert.deepEqual(outbox[0].playerUuid,player); assert.deepEqual(outbox[0].maidUuid,maid); assert.equal(outbox.length,1);
  assert.equal((await (await call('/minecraft/send','POST',{id:'once',messageId:'m-1',kind:'task',task:{jobId:'job-1',action:'script',args:{program:JSON.stringify({version:1,steps:[{op:'inspectInventory',item:'minecraft:stone',name:'count'},{op:'branch',kind:'variable',name:'count',value:'1',test:'ge',target:'2'},{op:'use',x:'1',y:'2',z:'3'}]})}}})).json()).state,'accepted');
});

test('persisted messages cannot bypass a changed source lock',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'rin-mc-relock-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const options={endpoint:'http://127.0.0.1:1',secret:minecraftToken,stateFile:join(folder,'state.json'),source:{serverId:inbound.serverId,playerUuid:player,maidUuid:maid},enqueue:async()=>{throw new Error('must not enqueue');}};
  const first=await new MinecraftTransport(options).open();
  first.state.inbox[inbound.id]={message:inbound,forwarded:false};
  first.state.pages=[{throughCursor:'c',ids:[inbound.id]}];await first.save();await first.close();
  const second=await new MinecraftTransport({...options,source:{...options.source,serverId:'different-server'}}).open();
  t.after(()=>second.close());
  assert.throws(()=>second.read(inbound.id),/source does not match/);
  await assert.rejects(second.forwardAndAck(),/source does not match/);
});

test('Minecraft can only target the configured persona and never shares Nerve bearer credentials', () => {
  const valid = {targets:{main:{type:'codex',threadId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},shell:{type:'command',argv:['true']}},minecraft:{endpoint:'http://127.0.0.1:9763/',stateFile:'/tmp/mc.json',tokenEnv:'MC_BRIDGE_TOKEN',target:'main',source:{serverId:'s',playerUuid:player,maidUuid:maid}}};
  assert.doesNotThrow(() => validateConfig(valid));
  assert.throws(() => validateConfig({...valid,minecraft:{...valid.minecraft,target:'shell'}}),/persona/);
  assert.throws(() => validateConfig({...valid,minecraft:{...valid.minecraft,tokenEnv:'NERVE_TOKEN'}}),/persona/);
  assert.doesNotThrow(() => new MinecraftTransport({endpoint:'http://[::1]/',secret:minecraftToken,stateFile:'/tmp/minecraft-transport-ipv6.json',source:{serverId:'s',playerUuid:player,maidUuid:maid},enqueue:async()=>{}}));
});
