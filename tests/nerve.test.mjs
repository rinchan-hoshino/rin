import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Nerve, scheduleSlot, runCommand, makeServer, validateConfig } from '../src/nerve.mjs';

test('a slow or unavailable Minecraft server does not block other events',async()=>{
 const store=new Store(':memory:');
 const nerve=new Nerve({targets:{out:{type:'command',argv:['true']}},triggers:[]},store);
 let rejectSync, attempts=0, scans=0;
 nerve.minecraft={syncOnce:()=>{attempts++;return new Promise((_,reject)=>{rejectSync=reject;});},close:async()=>{}};
 nerve.attention={scan:()=>{scans++;}};
 await nerve.poll();await nerve.poll();
 assert.equal(scans,2);assert.equal(attempts,1);
 const pending=nerve.minecraftSync;rejectSync(new Error('connection refused'));
 await pending;
 assert.equal(nerve.minecraftSync,undefined);
 await nerve.close();store.close();
});

test('durable dedupe, content collision and ambiguous crash recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nerve-')); const file=join(dir,'events.db');
 let db=new Store(file);
 assert.equal(db.enqueue('a','test',{v:1}),true);
 assert.equal(db.enqueue('a','test',{v:1}),false);
 assert.throws(()=>db.enqueue('a','test',{v:2}),/different content/);
 assert.equal(db.claim().id,'a');db.close();db=new Store(file);
 assert.equal(db.recover(),1);assert.equal(db.claim(),undefined);
 assert.equal(db.status()[0].state,'uncertain');assert.equal(db.retry('a'),1);
 const e=db.claim();db.finish(e.id,{accepted:true});assert.equal(db.status()[0].state,'done');
 db.close();rmSync(dir,{recursive:true});
});
test('false check consumes no delivery; stable keys dedupe across polling slots',async()=>{
 const store=new Store(':memory:');
 const config={targets:{out:{type:'command',argv:[process.execPath,'-e','process.exit(0)']}},triggers:[{id:'watch',everySeconds:1,target:'out',check:[process.execPath,'-e','console.log(JSON.stringify({ready:false}))']}]};
 const nerve=new Nerve(config,store);await nerve.scan(1000);assert.equal(store.status().length,0);
 config.triggers[0].check=[process.execPath,'-e','console.log(JSON.stringify({ready:true,key:"version-1",payload:{v:1}}))'];
 await nerve.scan(2000);await nerve.scan(3000);assert.equal(store.status().length,1);store.close();
});
test('failed checker never advances cursor',async()=>{
 const store=new Store(':memory:');
 const n=new Nerve({targets:{out:{type:'command',argv:['false']}},triggers:[{id:'a',everySeconds:1,target:'out',check:[process.execPath,'-e','process.exit(1)']}]},store);
 await n.scan(1000);assert.equal(store.lastSlot('a'),undefined);store.close();
});
test('scheduler respects Shanghai daily boundary and does not backfill missed intervals',()=>{
 const t={daily:'23:30',timeZone:'Asia/Shanghai'};
 assert.equal(scheduleSlot(t,Date.parse('2026-09-05T15:29:00Z')),null);
 assert.equal(scheduleSlot(t,Date.parse('2026-09-05T15:30:00Z')),'2026-09-05');
 assert.equal(scheduleSlot({everySeconds:30},90000),'3');
 assert.equal(scheduleSlot({at:'2026-09-05T15:30:00Z'},Date.parse('2026-09-05T15:29:00Z')),null);
});
test('argv preserves metacharacters and command limits terminate work',async()=>{
 const literal='hello; $(touch should-not-exist)';
 const r=await runCommand([process.execPath,'-e','process.stdin.pipe(process.stdout)'],literal);assert.equal(r.stdout,literal);
 await assert.rejects(runCommand([process.execPath,'-e','setInterval(()=>{},1000)'],'',{timeoutMs:80}),/timed out/);
 await assert.rejects(runCommand([process.execPath,'-e','console.log("x".repeat(5000))'],'',{maxBytes:100}),/limit/);
});
test('webhook requires auth, dedupes and rejects arbitrary targets',async()=>{
 const store=new Store(':memory:'); const n=new Nerve({targets:{out:{type:'command',argv:['true']}}},store);const token='test-token-with-at-least-24-chars';
 const server=makeServer(n,token);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await fetch(base+'/health')).status,401);
  const send=body=>fetch(base+'/events',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  assert.equal((await send({id:'x',target:'bad'})).status,400);
  assert.equal((await send({id:'x',target:'out',payload:{a:1}})).status,202);
  assert.equal((await send({id:'x',target:'out',payload:{a:1}})).status,200);
  assert.equal((await send({id:'x',target:'out',payload:{a:2}})).status,400);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
test('delivery waits for completion and retries only declared idempotent actions',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',argv:[process.execPath,'-e','process.exit(2)']}}},store);
 store.enqueue('non-idempotent','out',{});await n.tick();assert.equal(store.status()[0].state,'uncertain');
 n.config.targets.out.idempotent=true;store.enqueue('safe-retry','out',{});await n.tick();
 assert.equal(store.status().find(x=>x.id==='safe-retry').state,'pending');store.close();
});
test('invalid schedules and targets fail before service start',()=>{
 assert.throws(()=>validateConfig({targets:{},triggers:[{id:'a',target:'missing',everySeconds:1}]}),/Unknown/);
 assert.throws(()=>validateConfig({targets:{a:{type:'command',argv:['true']}},triggers:[{id:'a',target:'a',daily:'25:00'}]}),/Invalid/);
});
test('a running delivery does not block subsequent trigger polling',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',argv:['true']}}},store);
 let release,started;const gate=new Promise(r=>release=r);const ready=new Promise(r=>started=r);let scans=0;
 n.scan=async()=>{scans++;};n.deliver=async()=>{started();await gate;return {ok:true};};
 store.enqueue('slow','out',{});const first=n.tick();await ready;await n.tick();
 assert.equal(scans,2);assert.equal(store.status()[0].state,'running');release();await first;store.close();
});
test('UTF-8 split across subprocess writes remains intact',async()=>{
 const r=await runCommand([process.execPath,'-e','const b=Buffer.from("中文测试");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)'],'');assert.equal(r.stdout,'中文测试');
});
test('managed trigger edits persist, dedupe unchanged definitions and cancel stale pending work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nerve-managed-'));const path=join(dir,'events.db');let store=new Store(path);
 const config={targets:{out:{type:'command',argv:['true']}}};let n=new Nerve(config,store);
 const t={id:'watch',target:'out',everySeconds:10,payload:{v:1}};
 assert.equal(n.upsertTrigger(t).changed,true);await n.scan(10000);assert.equal(store.status().length,1);
 assert.equal(n.upsertTrigger({...t}).changed,false);await n.scan(10000);assert.equal(store.status().length,1);
 n.upsertTrigger({...t,payload:{v:2}});assert.equal(store.status()[0].state,'cancelled');await n.scan(10000);
 assert.equal(store.status().filter(e=>e.state==='pending').length,1);
 n.disableTrigger('watch');assert.equal(store.status().filter(e=>e.state==='pending').length,0);
 store.close();store=new Store(path);n=new Nerve(config,store);assert.equal(n.triggers()[0].enabled,false);await n.scan(20000);assert.equal(store.status().length,2);store.close();rmSync(dir,{recursive:true});
});
test('disabling a trigger during an asynchronous condition check does not enqueue work',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',argv:['true']}}},store);
 n.upsertTrigger({id:'slow',target:'out',everySeconds:1,check:[process.execPath,'-e','setTimeout(()=>console.log(JSON.stringify({ready:true})),100)']});
 const scanning=n.scan(1000);n.disableTrigger('slow');await scanning;assert.equal(store.status().length,0);store.close();
});
test('management API validates trigger definitions and returns persisted event results',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',argv:['true']}}},store);const token='test-token-with-at-least-24-chars';
 const server=makeServer(n,token);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=(path,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await call('/triggers','POST',{id:'a',target:'missing',everySeconds:1})).status,400);
  assert.equal((await call('/triggers','POST',{id:'a',target:'out',at:'2099-01-01T00:00:00Z'})).status,200);
  assert.equal((await (await call('/triggers')).json()).length,1);
  assert.equal((await call('/triggers/a','DELETE')).status,200);
  store.enqueue('complete','out',{});store.finish('complete',{completed:true,output:'ok'});
  assert.equal((await (await call('/events/complete')).json()).result.output,'ok');
 }finally{await new Promise(r=>server.close(r));store.close();}
});
