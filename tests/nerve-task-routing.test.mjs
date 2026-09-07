import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,Nerve,makeServer,validateConfig} from '../dist/nerve.js';
import {createAndBindTask} from '../dist/nerve-task-routing.js';
import {submitEvent} from '../dist/codex-input-command.js';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';
const target=(defaultThreadId=A)=>({type:'command',argv:['true'],taskRouting:{defaultThreadId}});

test('binding and event snapshots persist, isolate targets/sources, and survive uncertain retries',t=>{
 const dir=mkdtempSync(join(tmpdir(),'nerve-routing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'events.sqlite');let store=new Store(path);
 let nerve=new Nerve({targets:{one:target(),two:target(C)}},store);
 nerve.enqueue('default','one',{prompt:'first'},'timer');assert.equal(store.event('default').threadId,A);
 store.bindTask('one','timer',B);
 nerve.enqueue('bound','one',{prompt:'second'},'timer');nerve.enqueue('other-source','one',{},'other');nerve.enqueue('other-target','two',{},'timer');
 assert.equal(store.event('bound').threadId,B);assert.equal(store.event('other-source').threadId,A);assert.equal(store.event('other-target').threadId,C);
 store.bindTask('one','timer',C);
 assert.equal(nerve.enqueue('bound','one',{prompt:'second'},'timer'),false);assert.equal(store.event('bound').threadId,B);
 assert.throws(()=>nerve.enqueue('bound','one',{prompt:'second'},'other'),/different content/);
 assert.throws(()=>nerve.enqueue('bound','one',{prompt:'changed'},'timer'),/different content/);
 store.db.prepare("UPDATE events SET state='running' WHERE id='bound'").run();store.close();
 store=new Store(path);nerve=new Nerve({targets:{one:target(C)}},store);
 assert.equal(store.recover(),1);assert.equal(store.retry('bound'),1);assert.equal(store.event('bound').threadId,B);
 assert.deepEqual(store.taskBindings().map(row=>({...row})),[{target:'one',source:'timer',threadId:C}]);
 store.bindTask('one','timer',null);nerve.enqueue('reset','one',{},'timer');assert.equal(store.event('reset').threadId,C);
 store.close();
});

test('legacy rows remain intact and new routing metadata never rewrites payload',()=>{
 const store=new Store(':memory:');const nerve=new Nerve({targets:{one:target()}},store);
 const payload={prompt:'data',threadId:C,_personaThreadId:C,source:'different'};
 nerve.enqueue('payload','one',payload,'timer');assert.equal(store.event('payload').threadId,A);assert.deepEqual(store.event('payload').payload,payload);
 store.enqueue('legacy','one',{prompt:'old'});store.bindTask('one','timer',B);
 assert.equal(nerve.enqueue('legacy','one',{prompt:'old'}),false);assert.equal(store.event('legacy').threadId,null);
 store.close();
});

test('HTTP validates explicit bindings against native unarchived tasks and rejects event route overrides',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nerve-task-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const state=new DatabaseSync(join(dir,'state_5.sqlite'));state.exec('CREATE TABLE threads(id TEXT,archived INTEGER)');
 state.prepare('INSERT INTO threads VALUES(?,?)').run(B,0);state.prepare('INSERT INTO threads VALUES(?,?)').run(C,1);state.close();
 const store=new Store(':memory:');const nerve=new Nerve({targets:{one:{...target(),taskRouting:{defaultThreadId:A,codexHome:dir}},legacy:{type:'command',argv:['true']}}},store);
 const token='test-routing-token-at-least-24';const server=makeServer(nerve,token);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 for(const threadId of ['invalid',C,A])assert.equal((await post('/task-bindings',{target:'one',source:'timer',threadId})).status,400);
 assert.equal((await post('/task-bindings',{target:'legacy',source:'timer',threadId:B})).status,400);
 assert.equal((await post('/task-bindings',{target:'one',source:'timer',threadId:B})).status,200);
 assert.equal((await post('/events',{id:'one',target:'one',source:'timer',payload:{},threadId:C})).status,400);
 assert.equal((await post('/events',{id:'one',target:'one',source:'timer',payload:{threadId:C}})).status,202);
 assert.equal(store.event('one').threadId,B);
 assert.equal((await post('/task-bindings',{target:'one',source:'timer'})).status,200);
 const list=await (await fetch(base+'/task-bindings',{headers:{Authorization:`Bearer ${token}`}})).json();assert.deepEqual(list,{defaults:{one:A},bindings:[]});
});

test('delivery and Codex input consume only the captured envelope task',async()=>{
 const store=new Store(':memory:');const nerve=new Nerve({targets:{one:{...target(),argv:[process.execPath,'-e','process.stdin.pipe(process.stdout)']}}},store);
 nerve.enqueue('delivery','one',{prompt:'test',threadId:C},'timer');store.bindTask('one','timer',B);
 const event=store.claim();const delivered=JSON.parse((await nerve.deliver(event)).output);assert.equal(delivered.threadId,A);
 let seen;const bridge={start:async()=>{},queue:async(id)=>{seen=id;return {id};},stop:async()=>{}};
 await submitEvent(B,delivered,bridge);assert.equal(seen,A);
 await submitEvent(B,{id:'legacy',payload:{prompt:'old',threadId:C}},bridge);assert.equal(seen,B);
 await assert.rejects(submitEvent(B,{id:'bad',threadId:'bad',payload:{prompt:'bad'}},bridge),/UUID/);
 store.close();
});

test('create-and-bind persists without a turn, dedupes and preserves known task after binding failure',async()=>{
 const store=new Store(':memory:');const calls=[];
 const server={start(){},async connect(){},async request(method,args){calls.push({method,args});return {thread:{id:B}};},async stop(){}};
 const input={id:'create-one',target:'one',source:'timer',cwd:tmpdir(),name:'Test event task'};
 const first=await createAndBindTask(store,input,{defaultThreadId:A},server);assert.equal(first.state,'bound');assert.equal(first.threadId,B);
 assert.deepEqual(calls.map(c=>c.method),['thread/start','thread/inject_items','thread/name/set']);
 assert.equal((await createAndBindTask(store,input,{defaultThreadId:A},server)).state,'bound');assert.equal(calls.length,3);
 await assert.rejects(createAndBindTask(store,{...input,name:'Changed'},{defaultThreadId:A},server),/different arguments/);
 store.bindTask=()=>{throw new Error('write failed');};
 const failed=await createAndBindTask(store,{...input,id:'create-two'},{defaultThreadId:A},server);assert.equal(failed.state,'uncertain');assert.equal(failed.threadId,B);
 assert.equal(store.taskCreation('create-two').threadId,B);const count=calls.length;
 assert.equal((await createAndBindTask(store,{...input,id:'create-two'},{defaultThreadId:A},server)).state,'uncertain');assert.equal(calls.length,count);
 assert.ok(calls.every(c=>!['turn/start','thread/archive'].includes(c.method)));store.close();
});

test('concurrent create ID is claimed before native request and uncertainty is not replayed',async()=>{
 const store=new Store(':memory:');let release;let calls=0;
 const server={start(){},async connect(){await new Promise(r=>release=r);},async request(){calls++;throw new Error('timeout');},async stop(){}};
 const input={id:'once',target:'one',source:'timer',cwd:tmpdir()};
 const first=createAndBindTask(store,input,{defaultThreadId:A},server);
 const duplicate=await createAndBindTask(store,input,{defaultThreadId:A},server);assert.equal(duplicate.state,'pending');release();
 assert.equal((await first).state,'uncertain');assert.equal((await createAndBindTask(store,input,{defaultThreadId:A},server)).state,'uncertain');assert.equal(calls,1);store.close();
});

test('task routing is explicit and only valid on command targets',()=>{
 for(const taskRouting of [{defaultThreadId:'bad'},{defaultThreadId:A,command:['sh']},{defaultThreadId:A,codexHome:'relative'}])assert.throws(()=>validateConfig({targets:{one:{type:'command',argv:['true'],taskRouting}}}));
 assert.throws(()=>validateConfig({targets:{one:{type:'http',url:'https://example.invalid',taskRouting:{defaultThreadId:A}}}}),/command/);
});


test('producer cursor and enqueue share outer commit or rollback without closing its transaction',()=>{
 const store=new Store(':memory:');
 store.db.exec('CREATE TABLE cursor(value TEXT); BEGIN IMMEDIATE');
 store.db.prepare('INSERT INTO cursor VALUES(?)').run('first');
 store.enqueue('rolled-back','one',{},1,'timer',A);
 assert.equal(store.db.isTransaction,true);
 store.db.exec('ROLLBACK');
 assert.equal(store.event('rolled-back'),null);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cursor').get().n,0);
 store.enqueue('existing','one',{original:true},1,'timer',A);
 store.db.exec('BEGIN IMMEDIATE');
 store.db.prepare('INSERT INTO cursor VALUES(?)').run('kept');
 assert.throws(()=>store.enqueue('existing','one',{changed:true},2,'timer',B),/different content/);
 assert.equal(store.db.isTransaction,true);
 assert.equal(store.enqueue('existing','one',{original:true},2,'timer',B),false);
 assert.equal(store.db.isTransaction,true);
 store.enqueue('committed','one',{},2,'timer',B);
 store.db.exec('COMMIT');
 assert.equal(store.event('existing').threadId,A);
 assert.equal(store.event('committed').threadId,B);
 assert.equal(store.db.prepare('SELECT value FROM cursor').get().value,'kept');
 store.close();
});
