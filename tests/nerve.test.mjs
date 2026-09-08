import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, Nerve, runCommand, makeServer, validateConfig } from '../dist/nerve.js';

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

test('receipt means admission and a proven pre-submit refusal is retryable',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',receipt:true,argv:[process.execPath,'-e','console.log(JSON.stringify({accepted:false,retryable:true,error:"not submitted"}))']}}},store);
 store.enqueue('refused','out',{});await n.tick();await Promise.all(n.running);assert.equal(store.event('refused').state,'pending');
 n.config.targets.out.argv=[process.execPath,'-e','process.exit(2)'];store.enqueue('unknown','out',{});await n.tick();await Promise.all(n.running);assert.equal(store.event('unknown').state,'uncertain');
 n.config.targets.out.argv=[process.execPath,'-e','console.log(JSON.stringify({accepted:true,receipt:{messageId:"host-id"}}))'];store.enqueue('ok','out',{});await n.tick();await Promise.all(n.running);assert.equal(store.event('ok').state,'done');assert.equal(store.event('ok').result.receipt.messageId,'host-id');await n.close();store.close();
});
test('same target admissions serialize while unrelated targets can progress',async()=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{a:{type:'command',argv:['true']},b:{type:'command',argv:['true']}}},store);let release;const seen=[];
 n.deliver=async event=>{seen.push(event.id);if(event.id==='a1')await new Promise(r=>release=r);return {accepted:true};};
 store.enqueue('a1','a',{});store.enqueue('a2','a',{});store.enqueue('b1','b',{});await n.tick();await n.tick();await Promise.resolve();assert.deepEqual(seen,['a1','b1']);release();await Promise.all(n.running);await n.tick();await Promise.all(n.running);assert.deepEqual(seen,['a1','b1','a2']);await n.close();store.close();
});
test('producer fields are ignored while execution targets remain validated',()=>{
 for(const extra of [{triggers:[{id:'old'}]},{attention:{}},{minecraft:{}}])assert.doesNotThrow(()=>validateConfig({targets:{},...extra}));
 for(const type of ['codex','codex-app'])assert.throws(()=>validateConfig({targets:{out:{type,threadId:'existing'}}}),/Unknown target/);
 assert.throws(()=>validateConfig({targets:{out:{type:'command',argv:['node',null]}}}),/argv/);
});

test('runtime accepts retained trigger configuration without starting a legacy scheduler',async()=>{
 const store=new Store(':memory:');
 const n=new Nerve({targets:{out:{type:'command',argv:[process.execPath,'-e','console.log("ok")']}},triggers:[{id:'old',target:'out',everySeconds:1,payload:{old:true}}]},store);
 try {
  await n.tick();assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
  n.enqueue('explicit','out',{new:true});await n.tick();await Promise.all(n.running);
  assert.equal(store.event('explicit').state,'done');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
 } finally {await n.close();store.close();}
});
