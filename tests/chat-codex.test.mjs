import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexBridge } from '../src/chat/codex.mjs';

async function fixture(t, { fail = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'call.json');
  const peer = join(dir, 'peer.mjs');
  await writeFile(peer, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),home:process.env.CODEX_HOME}));
${fail ? "console.error('queue rejected');process.exit(7);" : "console.log(JSON.stringify({messageId:'22222222-2222-4222-8222-222222222222'}));"}
`);
  return { dir, log, command: [process.execPath, peer, log] };
}

test('queues text and attachments to an existing thread without permission overrides', async t => {
  const f = await fixture(t);
  const bridge = new CodexBridge({ command: f.command, codexHome: join(f.dir, 'home') });
  await bridge.start();
  const result = await bridge.queue('thread-one', {
    text: 'literal $(text); 中文',
    files: [
      { path: '/tmp/notes.pdf', name: 'notes.pdf', mimeType: 'application/pdf' },
    ],
  });
  assert.deepEqual(result, {
    threadId: 'thread-one',
    messageId: '22222222-2222-4222-8222-222222222222',
  });
  const call = JSON.parse(await readFile(f.log, 'utf8'));
  assert.deepEqual(call.args, [
    'queue', '--thread', 'thread-one', '--message',
    'literal $(text); 中文\n\nLocal attachments:\n- notes.pdf (application/pdf): /tmp/notes.pdf',
  ]);
  assert.equal(call.home, join(f.dir, 'home'));
  assert.equal(call.args.some(value => /sandbox|approval|remote/.test(value)), false);
  await assert.rejects(bridge.queue('thread-one', {files:[{path:'/tmp/only.png',mimeType:'image/png'}]}), {code:'CODEX_INPUT_UNSUPPORTED'});
});

test('requires start, validates inputs, and propagates queue failure', async t => {
  const f = await fixture(t, { fail: true });
  const bridge = new CodexBridge({ command: f.command });
  await assert.rejects(bridge.queue('thread-one', { text: 'hello' }), /not started/);
  await bridge.start();
  await assert.rejects(bridge.queue('', { text: 'hello' }), /threadId required/);
  await assert.rejects(bridge.queue('thread-one', { text: '' }), /text or files required/);
  await assert.rejects(bridge.queue('thread-one', { text: 'hello', files: [{ path: '' }] }), /files must/);
  await assert.rejects(bridge.queue('thread-one', { text: 'hello' }), /queue rejected/);
});

function historyFixture(dir) {
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cli_version TEXT NOT NULL, history_mode TEXT NOT NULL)`);
  state.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('thread-one', '0.153.4', 'paginated');
  state.close();
  const history = new DatabaseSync(join(dir, 'thread_history_1.sqlite'));
  history.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
      PRIMARY KEY(thread_id, turn_id));
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
      item_type TEXT NOT NULL, updated_at_ordinal INTEGER NOT NULL,
      PRIMARY KEY(thread_id, turn_id, item_id));
  `);
  return history;
}

const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('event wait timed out');
};

test('read-only observer baselines history and emits only new public output and completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  t.after(() => db.close());
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'old', 1, 'completed', null, 1, 2);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'old', 'old-message', 2, 1, JSON.stringify({ type: 'agentMessage', id: 'old-message', text: 'old answer', phase: 'final_answer' }), 'agentMessage', 2,
  );
  const events = [];
  const bridge = new CodexBridge({ command: ['codex'], codexHome: dir, pollMs: 10, onEvent: event => events.push(event) });
  await bridge.start();
  const unwatch = bridge.watch('thread-one');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(events, []);

  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'new', 3, 'inProgress', null, 3, null);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'tool', 4, 4, JSON.stringify({ type: 'commandExecution', aggregatedOutput: 'secret tool output' }), 'commandExecution', 4,
  );
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'reason', 5, 5, JSON.stringify({ type: 'reasoning', summary: ['Obsolete public summary', 'Public summary'], content: ['private reasoning'] }), 'reasoning', 5,
  );
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'new', 'answer', 6, 6, JSON.stringify({ type: 'agentMessage', text: 'Work', phase: 'commentary' }), 'agentMessage', 6,
  );
  await waitFor(() => events.length === 3);
  assert.deepEqual(events.map(event => [event.type, event.itemId, event.text]), [
    ['started', undefined, undefined],
    ['text', 'reason', 'Public summary'],
    ['text', 'answer', 'Work'],
  ]);
  assert.equal(events[1].phase, 'summary');
  assert.equal(JSON.stringify(events).includes('Obsolete public summary'), false);
  assert.equal(JSON.stringify(events).includes('private reasoning'), false);
  assert.equal(JSON.stringify(events).includes('secret tool output'), false);

  db.prepare('UPDATE thread_items SET item_json=?, updated_at_ordinal=? WHERE item_id=?').run(
    JSON.stringify({ type: 'agentMessage', text: 'Working', phase: 'commentary' }), 7, 'answer',
  );
  await waitFor(() => events.length === 4);
  assert.equal(events[3].text, 'Working');
  assert.equal(events[3].delta, undefined);
  db.prepare('UPDATE thread_turns SET status=?, completed_at=? WHERE turn_id=?').run('completed', 8, 'new');
  await waitFor(() => events.at(-1)?.type === 'completed');
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'bad', 9, 'failed', JSON.stringify({ message: 'model failed' }), 9, 10,
  );
  await waitFor(() => events.at(-1)?.type === 'failed');
  assert.deepEqual(events.slice(-2).map(event => [event.type, event.turnId, event.text]), [
    ['started', 'bad', undefined],
    ['failed', 'bad', 'model failed'],
  ]);
  unwatch();
  await bridge.stop();
});

test('observer rejects unsupported history schema and stop disables watch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  db.close();
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.prepare('UPDATE threads SET cli_version=?').run('0.154.0');
  state.close();
  const bridge = new CodexBridge({ codexHome: dir });
  await bridge.start();
  assert.throws(() => bridge.watch('thread-one'), /Unsupported Codex history schema/);
  await bridge.stop();
  assert.throws(() => bridge.watch('thread-one'), /not started/);
});

test('observer reports live schema drift as a typed event without crashing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  db.close();
  const events = [];
  const bridge = new CodexBridge({ codexHome: dir, pollMs: 10, onEvent: event => events.push(event) });
  await bridge.start();
  bridge.watch('thread-one');
  const state = new DatabaseSync(join(dir, 'state_5.sqlite'));
  state.prepare('UPDATE threads SET cli_version=?').run('0.154.0');
  state.close();
  await waitFor(() => events.some(event => event.type === 'observerError'));
  assert.match(events.at(-1).text, /Unsupported Codex history schema/);
  await bridge.stop();
});

test('persistent cursor catches a missed final after observer restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = historyFixture(dir);
  t.after(() => db.close());
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one', 'active', 1, 'inProgress', null, 1, null);
  let cursor;
  const cursorApi = {
    getCursor: () => cursor,
    setCursor: (_key, value) => { cursor = structuredClone(value); },
  };
  const first = new CodexBridge({ codexHome: dir, pollMs: 10, ...cursorApi });
  await first.start();
  first.watch('thread-one');
  await first.stop();
  assert.deepEqual(cursor.activeTurns.map(row => row.turnId), ['active']);

  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one', 'active', 'final', 2, 2, JSON.stringify({ type: 'agentMessage', text: 'Finished' }), 'agentMessage', 2,
  );
  db.prepare('UPDATE thread_turns SET status=?, completed_at=? WHERE turn_id=?').run('completed', 3, 'active');
  const events = [];
  const second = new CodexBridge({ codexHome: dir, pollMs: 10, onEvent: event => events.push(event), ...cursorApi });
  await second.start();
  second.watch('thread-one');
  await waitFor(() => events.at(-1)?.type === 'completed');
  assert.deepEqual(events.map(event => [event.type, event.phase, event.text]), [
    ['text', 'final', 'Finished'],
    ['completed', undefined, undefined],
  ]);
  await second.stop();
});

test('App text and images share IPC; backend selects start for idle threads', async t => {
  const f = await fixture(t); const bridge = new CodexBridge({command:f.command});
  await bridge.start(); t.after(()=>bridge.stop());
  const calls=[];bridge.appIpc={steer:async(thread,input)=>{calls.push({thread,input});return {threadId:thread,messageId:'mid',turnId:'turn',transport:'app-ipc-steer'};},stop:async()=>{}};
  bridge.threadContext=()=>({cwd:f.dir,active:true});
  const receipt=await bridge.queue('thread',{text:'change direction'});
  assert.equal(receipt.transport,'app-ipc-steer');assert.equal(calls.length,1);
  await assert.rejects(readFile(f.log),{code:'ENOENT'});
  await bridge.queue('thread',{text:'image',files:[{path:'/tmp/photo.png',mimeType:'image/png'}]});assert.equal(calls.length,2);assert.equal(calls[1].input.files[0].path,'/tmp/photo.png');
  bridge.threadContext=()=>({cwd:f.dir,active:false});await bridge.queue('thread',{text:'next task'});assert.equal(calls.length,3);assert.equal(calls[2].input.start,true);await assert.rejects(readFile(f.log),{code:'ENOENT'});
});

test('unknown steer outcome never falls back to queue; absent owner may queue', async t => {
  const f=await fixture(t); const bridge=new CodexBridge({command:f.command});await bridge.start();t.after(()=>bridge.stop());
  bridge.threadContext=()=>({cwd:f.dir,active:true});bridge.appIpc={steer:async()=>{throw Error('outcome uncertain');},stop:async()=>{}};
  await assert.rejects(bridge.queue('thread',{text:'one'}),/uncertain/);await assert.rejects(readFile(f.log),{code:'ENOENT'});
  bridge.appIpc.steer=async()=>null;await bridge.queue('thread',{text:'two'});assert.ok(JSON.parse(await readFile(f.log,'utf8')).args.includes('two'));
});

test('steering reads latest turn and original cwd without mutating Codex state', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-steer-state-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const state=new DatabaseSync(join(dir,'state_5.sqlite'));state.exec("CREATE TABLE threads(id TEXT,cwd TEXT,cli_version TEXT,history_mode TEXT); INSERT INTO threads VALUES('thread','/original/project','0.153.4','paginated')");state.close();
  const history=new DatabaseSync(join(dir,'thread_history_1.sqlite'));history.exec("CREATE TABLE thread_turns(thread_id TEXT,status TEXT,rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES('thread','inProgress',1)");
  const bridge=new CodexBridge({codexHome:dir});assert.deepEqual(bridge.activeThread('thread'),{cwd:'/original/project'});
  history.exec("INSERT INTO thread_turns VALUES('thread','completed',2)");assert.equal(bridge.activeThread('thread'),null);history.close();
  assert.equal(bridge.activeThread('missing'),null);
});

test('async final_answer questions do not terminate the visible output stream', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-question-history-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=historyFixture(dir);t.after(()=>db.close());
  const events=[];
  const bridge=new CodexBridge({codexHome:dir,pollMs:10,onEvent:event=>events.push(event)});
  await bridge.start();t.after(()=>bridge.stop());bridge.watch('thread-one');
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)').run('thread-one','turn',1,'inProgress',null,1,null);
  const items=[
    {text:'before',phase:'commentary'},
    {text:'Which permission?',phase:'final_answer',delivery:'async',questions:[{title:'Which permission?',options:null}]},
    {text:'after',phase:'commentary'},
    {text:'Another question',phase:'final_answer',questions:[{title:'Another question'}]},
    {text:'finished',phase:'final_answer',delivery:null,questions:null},
  ];
  for(const [index,item] of items.entries())db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    'thread-one','turn',`item-${index}`,index+2,index+2,JSON.stringify({type:'agentMessage',...item}),'agentMessage',index+2,
  );
  await waitFor(()=>events.length===6);
  assert.deepEqual(events.filter(event=>event.type==='text').map(({phase,text})=>({phase,text})),[
    {phase:'commentary',text:'before'},
    {phase:'question',text:'Which permission?'},
    {phase:'commentary',text:'after'},
    {phase:'question',text:'Another question'},
    {phase:'final',text:'finished'},
  ]);
});

async function wakeFixture(t, options = {}) {
  const f = await fixture(t);
  const wakes = [];
  const bridge = new CodexBridge({ command: f.command, appSteering: true, appWake: true,
    wakeApp: async id => { wakes.push(id); }, queueTimeoutMs: 1000, ...options });
  await bridge.start();
  t.after(() => bridge.stop());
  bridge.threadContext = () => ({ cwd: f.dir, active: false });
  bridge.appIpc = { steer: async () => null, stop: async () => {} };
  return { ...f, bridge, wakes };
}

test('unloaded App task wakes once, rereads busy state, and delivers without native queue', async t => {
  const f = await wakeFixture(t);
  const calls = [];
  let active = false;
  f.bridge.threadContext = () => ({ cwd: f.dir, active });
  f.bridge.appIpc.steer = async (_id, input) => {
    calls.push(input);
    if (calls.length === 1) { active = true; return null; }
    if (calls.length === 2) return null;
    return { threadId: 'thread', turnId: 'active-turn', transport: 'app-ipc-steer' };
  };
  const input = { text: 'image and text', files: [{ path: '/tmp/image.png', mimeType: 'image/png' }] };
  const receipt = await f.bridge.queue('thread', input);
  assert.deepEqual(f.wakes, ['thread']);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.start), [true, false, false]);
  assert.deepEqual(calls.map(call => call.files), [input.files, input.files, input.files]);
  assert.equal(receipt.turnId, 'active-turn');
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('an existing App owner does not wake or queue again', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return { turnId: 'turn' }; };
  assert.deepEqual(await f.bridge.queue('thread', { text: 'hello' }), { turnId: 'turn' });
  assert.equal(calls, 1);
  assert.deepEqual(f.wakes, []);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('ambiguous App mutation after wake is never replayed or queued', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => {
    if (++calls === 1) return null;
    throw new Error('mutation outcome uncertain');
  };
  await assert.rejects(f.bridge.queue('thread', { text: 'send once' }), /outcome uncertain/);
  assert.equal(calls, 2);
  assert.deepEqual(f.wakes, ['thread']);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('ambiguous initial App submission does not launch wake retry', async t => {
  const f = await wakeFixture(t);
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; throw new Error('receipt lost'); };
  await assert.rejects(f.bridge.queue('thread', { text: 'send once' }), /receipt lost/);
  assert.equal(calls, 1);
  assert.deepEqual(f.wakes, []);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('App load timeout never leaves a silently stranded native queue message', async t => {
  const f = await wakeFixture(t, { queueTimeoutMs: 10 });
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return null; };
  await assert.rejects(f.bridge.queue('thread', { text: 'cannot load' }), /wake timed out; message was not queued/);
  assert.ok(calls >= 2);
  assert.deepEqual(f.wakes, ['thread']);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('App wake failure propagates without retrying business input', async t => {
  const f = await wakeFixture(t, { wakeApp: async () => { throw new Error('URL handler unavailable'); } });
  let calls = 0;
  f.bridge.appIpc.steer = async () => { calls++; return null; };
  await assert.rejects(f.bridge.queue('thread', { text: 'cannot open' }), /URL handler unavailable/);
  assert.equal(calls, 1);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('observer emits completed image artifacts without exposing image payload or tool output, and resumes once', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-image-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const db=historyFixture(dir);t.after(()=>db.close());
  const events=[];let cursor;
  const options={codexHome:dir,pollMs:10,onEvent:e=>events.push(e),getCursor:()=>cursor,setCursor:(_k,v)=>{cursor=v;}};
  let bridge=new CodexBridge(options);await bridge.start();bridge.watch('thread-one');
  db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)').run('thread-one','image-turn',1,'inProgress',null,1,null);
  const insert=db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)');
  insert.run('thread-one','image-turn','image',2,2,JSON.stringify({status:'inProgress',savedPath:'/tmp/not-ready.png',result:'private pixels'}),'imageGeneration',2);
  insert.run('thread-one','image-turn','tool',3,3,JSON.stringify({output:'private tool image'}),'mcpToolCall',3);
  await waitFor(()=>events.some(e=>e.type==='started'));
  const path=join(dir,'generated_images','thread-one','image.png');
  db.prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=4 WHERE item_id=?').run(JSON.stringify({status:'completed',savedPath:path,result:'private pixels',revisedPrompt:'private prompt'}),'image');
  await waitFor(()=>events.some(e=>e.type==='image'));
  assert.deepEqual(events.filter(e=>e.type==='image'),[{threadId:'thread-one',turnId:'image-turn',type:'image',itemId:'image',path}]);
  assert.equal(JSON.stringify(events).includes('private'),false);
  await bridge.stop();bridge=new CodexBridge(options);await bridge.start();bridge.watch('thread-one');
  await new Promise(r=>setTimeout(r,35));await bridge.stop();
  assert.equal(events.filter(e=>e.type==='image').length,1);
});
