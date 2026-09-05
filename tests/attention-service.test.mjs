import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/nerve.mjs';
import {AttentionService} from '../src/attention-service.mjs';
const config = {ownerUserIds:['owner'],ignoredChatKeys:['discord/bot:notes'],mirrorDiscordChannelIds:['mirror'],mirrorDiscordCategoryId:'category',ambientWindowMs:900000,target:'main'};
const at = Date.parse('2026-09-05T12:01:00Z');
const record = (extra={}) => ({id:'a',messageId:'123',platform:'discord',platformInstance:'bot',chatKey:'discord/bot:room',chatType:'group',userId:'owner',authorName:'Owner',text:'secret message text',receivedAt:new Date(at).toISOString(),disposition:'record_only',ancestorIds:[],...extra});
function setup(t,options={}) { const store = new Store(':memory:'); t.after(()=>store.close()); return {store,service:new AttentionService(config,store,options)}; }

test('accept derives owner trust, dedupes canonical records, persists pending and emits range-only event once', t=>{
  const {store,service} = setup(t);
  assert.deepEqual(service.accept(record()),{inserted:true,attention:true});
  assert.deepEqual(service.accept(record()),{inserted:false});
  const resumed = new AttentionService(config,store);
  const result = resumed.scan(at);
  assert.equal(result.emitted,true);
  assert.equal(store.event(result.id).payload.priority,100);
  assert.match(store.event(result.id).payload.prompt,/nerve_read_chat/);
  assert.match(store.event(result.id).payload.prompt,/nerve_send_chat/);
  assert.equal(JSON.stringify(store.event(result.id).payload).includes('secret message text'),false);
  assert.deepEqual(resumed.scan(at),{emitted:false});
  assert.equal(resumed.read({chatKey:'discord/bot:room'}).messages[0].text,'secret message text');
});
test('bot/self/assistant excluded, forged trust not owner, ignored and mirrored channels never stimulate',t=>{
  const {service,store} = setup(t);
  for (const extra of [{bot:true},{authorBot:true},{role:'assistant'},{userId:'bot'}]) assert.equal(service.accept(record(extra)).ignored,true);
  service.accept(record({id:'ambient',userId:'visitor',trust:'OWNER'}));
  service.accept(record({id:'notes',chatKey:'discord/bot:notes'}));
  service.accept(record({id:'mirror',chatKey:'discord/bot:mirror'}));
  service.accept(record({id:'child',chatKey:'discord/bot:child',ancestorIds:['category']}));
  service.accept(record({id:'actionable',disposition:'actionable'}));
  assert.equal(service.scan(at).emitted,false);
  const batch = service.scan(Date.parse('2026-09-05T12:15:00Z'));
  assert.equal(store.event(batch.id).payload.messages,1);
  assert.equal(store.event(batch.id).payload.priority,20);
});
test('failed event enqueue rolls state back and can be retried without losing pending records',t=>{
  const {service,store} = setup(t);
  service.accept(record());
  const enqueue = store.enqueue;
  store.enqueue = (...args)=>{enqueue.apply(store,args);throw new Error('storage fault');};
  assert.throws(()=>service.scan(at),/storage fault/);
  assert.equal(service.state().pending.length,1);
  assert.equal(store.status().length,0);
  store.enqueue = enqueue;
  assert.equal(service.scan(at).emitted,true);
  assert.equal(store.status().length,1);
});
test('read pagination stays inside one chat and returns chronological messages',t=>{
  const {service} = setup(t);
  service.accept(record({id:'a'})); service.accept(record({id:'b'})); service.accept(record({id:'c'}));
  service.accept(record({id:'other',chatKey:'discord/bot:other'}));
  assert.deepEqual(service.read({chatKey:'discord/bot:room',limit:2}).messages.map(x=>x.id),['b','c']);
  assert.deepEqual(service.read({chatKey:'discord/bot:room',before:'b'}).messages.map(x=>x.id),['a']);
  assert.throws(()=>service.read({chatKey:'discord/bot:room',before:'other'}),/cursor/);
});
test('explicit sends require recorded allowed destination and stable ids prevent duplicate network calls',async t=>{
  const calls=[];
  const {service} = setup(t,{send:async input=>{calls.push(input);return {id:'receipt'};}});
  service.accept(record()); service.accept(record({id:'mirror',chatKey:'discord/bot:mirror'}));
  await assert.rejects(()=>service.send({id:'s',chatKey:'discord/bot:unknown',text:'hello'}),/recorded/);
  await assert.rejects(()=>service.send({id:'s',chatKey:'discord/bot:mirror',text:'hello'}),/excluded/);
  await assert.rejects(()=>service.send({id:'bad-reply',chatKey:'discord/bot:room',text:'hello',replyTo:'999'}),/same recorded chat/);
  await assert.rejects(()=>service.send({id:'oversize',chatKey:'discord/bot:room',text:'x'.repeat(2001)}),/Invalid/);
  assert.equal((await service.send({id:'reply',chatKey:'discord/bot:room',text:'reply',replyTo:'123'})).state,'sent');
  assert.equal((await service.send({id:'s',chatKey:'discord/bot:room',text:'hello'})).state,'sent');
  assert.equal((await service.send({id:'s',chatKey:'discord/bot:room',text:'hello'})).deduplicated,true);
  assert.equal(calls.length,2);
  await assert.rejects(()=>service.send({id:'s',chatKey:'discord/bot:room',text:'different'}),/reused/);
});
test('ambiguous send stays uncertain across restart and does not retry',async t=>{
  let attempts=0;
  const send=async()=>{attempts++;throw new Error('network disconnected');};
  const {service,store}=setup(t,{send}); service.accept(record());
  const request={id:'s',chatKey:'discord/bot:room',text:'hello'};
  assert.equal((await service.send(request)).state,'uncertain');
  const resumed=new AttentionService(config,store,{send});
  assert.equal((await resumed.send(request)).state,'uncertain');
  assert.equal(attempts,1);
});


test('canonical read preserves reply and attachment metadata without fetching URLs',t=>{
  const {service}=setup(t);
  const attachments=[{name:'photo.png',url:'https://cdn.discordapp.com/attachments/example/photo.png',mimeType:'image/png'}];
  service.accept(record({attachments,replyTo:'456'}));
  const saved=service.read({chatKey:'discord/bot:room'}).messages[0];
  assert.deepEqual(saved.attachments,attachments);
  assert.equal(saved.replyTo,'456');
  assert.throws(()=>service.accept(record({id:'bad-url',attachments:[{url:'file:///tmp/secret'}]})),/URL/);
});
