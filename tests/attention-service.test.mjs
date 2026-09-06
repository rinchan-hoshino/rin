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
  const result = resumed.scan(at+30000);
  assert.equal(result.emitted,true);
  assert.equal(store.event(result.id).payload.priority,60);
  assert.match(store.event(result.id).payload.prompt,/nerve_read_chat/);
  assert.match(store.event(result.id).payload.prompt,/nerve_send_chat/);
  assert.equal(JSON.stringify(store.event(result.id).payload).includes('secret message text'),false);
  assert.deepEqual(resumed.scan(at+30000),{emitted:false,suppressed:true});
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
  assert.throws(()=>service.scan(at+30000),/storage fault/);
  assert.equal(service.state().pending.length,1);
  assert.equal(store.status().length,0);
  store.enqueue = enqueue;
  assert.equal(service.scan(at+30000).emitted,true);
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

test('reading marks only the returned page viewed and survives restart',t=>{
  const {service,store}=setup(t);
  service.accept(record({id:'a'}));service.accept(record({id:'b'}));service.accept(record({id:'c'}));
  assert.equal(service.state().pending.length,3);
  assert.deepEqual(service.read({chatKey:'discord/bot:room',limit:2}).messages.map(x=>x.id),['b','c']);
  assert.deepEqual(service.state().pending.map(x=>x.messageId),['a']);
  const resumed=new AttentionService(config,store);
  assert.equal(resumed.read({chatKey:'discord/bot:room',limit:1,markViewed:false}).markedViewed,false);
  assert.deepEqual(resumed.state().pending.map(x=>x.messageId),['a']);
  resumed.read({chatKey:'discord/bot:room',before:'b'});
  assert.equal(resumed.state().pending.length,0);
});

test('mentions and explicitly awaited replies are prioritized without making every send awaiting',async t=>{
  const {service}=setup(t,{send:async()=>({id:'receipt'})});
  service.accept(record({id:'seed'}));service.read({chatKey:'discord/bot:room'});
  await service.send({id:'ordinary-send',chatKey:'discord/bot:room',text:'hello'});
  service.accept(record({id:'ordinary-reply',messageId:'124',userId:'visitor',receivedAt:new Date(at+1000).toISOString()}));
  assert.equal(service.state().pending[0].reason,'ambient');service.read({chatKey:'discord/bot:room'});
  await service.send({id:'question',chatKey:'discord/bot:room',text:'question?',awaitingReply:true});
  service.accept(record({id:'answer',messageId:'125',userId:'visitor',receivedAt:new Date(Date.now()+100).toISOString()}));
  assert.equal(service.state().pending[0].reason,'awaiting_reply');assert.equal(service.state().pending[0].priority,90);
  service.read({chatKey:'discord/bot:room'});
  service.accept(record({id:'mention',messageId:'126',userId:'visitor',mentionedBot:true,receivedAt:new Date(at+3000).toISOString()}));
  assert.equal(service.state().pending[0].reason,'mentioned');assert.equal(service.state().pending[0].priority,100);
});

test('pending and running attention events suppress duplicate wakeups while unread remains queued',t=>{
  const {service,store}=setup(t);service.accept(record());
  const first=service.scan(at+30000);assert.equal(first.emitted,true);assert.equal(service.state().pending.length,1);
  assert.equal(service.scan(at+330000).suppressed,true);
  const event=store.claim(at+30000);assert.equal(event.source,'chat-attention');assert.equal(service.scan(at+330000).suppressed,true);
  store.finish(event.id,{ok:true});
  assert.equal(service.scan(at+330000).emitted,true);
});

test('channel policy and bounded attention mode override the detected busy state',t=>{
  const configured={...config,channels:{'discord/bot:room':{mode:'normal',idleDelayMs:1000,maxDelayMs:10000,idleOnly:false}}};
  const store=new Store(':memory:');t.after(()=>store.close());const service=new AttentionService(configured,store);
  service.accept(record());assert.equal(service.scan(at+1000,{active:true}).emitted,false);
  service.read({chatKey:'discord/bot:room',limit:1,markViewed:false,attentionMode:'idle',attentionForMs:5000});
  assert.equal(service.scan(at+1000,{active:true}).emitted,true);
});

test('stored version one attention state migrates on use',t=>{
  const {service}=setup(t);service.store.db.prepare('UPDATE attention_state SET state=? WHERE id=1').run(JSON.stringify({version:1,pending:[]}));
  service.accept(record());const state=service.state();assert.equal(state.version,2);assert.deepEqual(state.chats['discord/bot:room'],{});
});

test('new mentions reach an active turn while earlier notification completion is still pending',t=>{
  const {service,store}=setup(t);
  service.accept(record({id:'old',messageId:'100'}));
  const first=service.scan(at+30000);
  const running=store.claim(at+30000);
  assert.equal(running.id,first.id);
  service.accept(record({id:'new-mention',messageId:'101',mentionedBot:true,receivedAt:new Date(at+40000).toISOString()}));
  assert.equal(service.scan(at+69999,{active:true}).emitted,false);
  const next=service.scan(at+70000,{active:true});
  assert.equal(next.emitted,true);
  assert.equal(store.event(next.id).payload.priority,100);
  assert.deepEqual(store.event(next.id).payload.messageIds,['new-mention']);
  assert.equal(store.event(first.id).state,'running');
  assert.equal(service.scan(at+400000,{active:true}).suppressed,true);
  const resumed=new AttentionService(config,store);
  assert.equal(resumed.scan(at+500000,{active:true}).emitted,false);
  assert.equal(store.status().length,2);
});

test('new ordinary messages retain their busy deadline without inheriting another batch completion wait',t=>{
  const {service,store}=setup(t);
  service.accept(record({id:'old',messageId:'100'}));
  service.scan(at+30000);
  service.accept(record({id:'new',messageId:'101',receivedAt:new Date(at+40000).toISOString()}));
  assert.equal(service.scan(at+339999,{active:true}).emitted,false);
  const next=service.scan(at+340000,{active:true});
  assert.equal(next.emitted,true);
  assert.deepEqual(store.event(next.id).payload.messageIds,['new']);
  assert.equal(store.event(next.id).payload.priority,60);
});

test('legacy in-flight ranges suppress only messages already covered by that chat range',t=>{
  const {service,store}=setup(t);
  service.accept(record({id:'a',messageId:'100'}));
  store.enqueue('legacy','main',{groups:[{chatKey:'discord/bot:room',firstMessageId:'a',lastMessageId:'a'}]},at,'chat-attention');
  service.accept(record({id:'b',messageId:'101',mentionedBot:true}));
  const next=service.scan(at+30000,{active:true});
  assert.equal(next.emitted,true);
  assert.deepEqual(store.event(next.id).payload.messageIds,['b']);
  assert.equal(service.state().pending.length,2);
});

test('another target cannot suppress this target and sequential mentions keep separate exact identities',t=>{
  const {service,store}=setup(t);
  store.enqueue('other-target','elsewhere',{messageIds:['a']},at,'chat-attention');
  for (const [index,id] of ['a','b','c'].entries()) {
    service.accept(record({id,messageId:String(100+index),mentionedBot:true,receivedAt:new Date(at+index*40000).toISOString()}));
    const result=service.scan(at+index*40000+30000,{active:true});
    assert.equal(result.emitted,true);
    assert.deepEqual(store.event(result.id).payload.messageIds,[id]);
  }
  assert.equal(service.scan(at+180000,{active:true}).emitted,false);
});
