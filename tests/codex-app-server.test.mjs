import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexBridge } from '../dist/chat/codex.js';
import { CodexAppServer } from '../dist/codex-app-server.js';

async function peer(t, handle = () => undefined) {
  const wss = new WebSocketServer({port: 0, host: '127.0.0.1'});
  await once(wss, 'listening');
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); });
  const calls = [];
  wss.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(String(raw)); calls.push(m);
    if (!m.id) return;
    if (handle(m, ws) === true) return;
    const result = m.method === 'thread/start' ? {thread:{id:'new-thread'}} : m.method === 'turn/start' ? {turn:{id:'shared-turn'}} : {};
    ws.send(JSON.stringify({id:m.id,result}));
  }));
  const options = {endpoint:`ws://127.0.0.1:${wss.address().port}`, queueTimeoutMs:500};
  const bridge = new CodexBridge(options); await bridge.start(); t.after(() => bridge.stop());
  return {wss, calls, bridge, options};
}

test('resumes and submits images/text on the shared server without changing execution settings', async t => {
  const {bridge,calls} = await peer(t);
  let clientId;
  const r = await bridge.queue('existing', {text:'$(literal) 中文', files:[{path:'/tmp/a.png',mimeType:'image/png'},{path:'/tmp/b.pdf',name:'b.pdf'}],onClientMessageId:id=>clientId=id});
  assert.equal(r.transport,'app-server'); assert.equal(r.turnId,'shared-turn'); assert.equal(r.messageId,clientId);
  assert.deepEqual(calls.map(x=>x.method),['initialize','initialized','thread/resume','turn/start']);
  assert.deepEqual(calls[2].params,{threadId:'existing',excludeTurns:true});
  assert.deepEqual(calls[3].params,{threadId:'existing',clientUserMessageId:clientId,input:[
    {type:'text',text:'$(literal) 中文\n\nLocal attachments:\n- b.pdf: /tmp/b.pdf',text_elements:[]},
    {type:'localImage',path:'/tmp/a.png'},
  ]});
  await bridge.queue('existing',{text:'while busy'});
  assert.equal(calls.filter(x=>x.method==='initialize').length,1);
  assert.equal(calls.filter(x=>x.method==='turn/start').length,2);
});

test('validates before connection; stopped clients cannot send', async t => {
  const {bridge,calls}=await peer(t);
  await assert.rejects(bridge.queue('',{text:'x'}),/threadId/);
  await assert.rejects(bridge.queue('id',{}),/text or files/);
  await assert.rejects(bridge.queue('id',{files:[{path:''}]}),/files must/);
  assert.equal(calls.length,0);
  await bridge.stop(); await assert.rejects(bridge.queue('id',{text:'x'}),/not started/);
});

test('creation uses the same connection, persists routing, and does not start a model turn', async t => {
  const {bridge,calls}=await peer(t);
  assert.equal(await bridge.createThread({cwd:'.',name:'频道'}),'new-thread');
  assert.deepEqual(calls.map(x=>x.method),['initialize','initialized','thread/start','thread/inject_items','thread/name/set']);
  assert.deepEqual(calls[2].params,{cwd:process.cwd()});
  assert.equal(calls[3].params.items[0].role,'developer');
  await bridge.queue('new-thread',{text:'hello'});
  assert.equal(calls.filter(x=>x.method==='initialize').length,1);
});

for (const method of ['thread/start','thread/inject_items','thread/name/set']) test(`creation loss at ${method} never repeats creation`, async t => {
  const {bridge,calls}=await peer(t,(m,ws)=>{if(m.method===method){ws.terminate();return true;}});
  await assert.rejects(bridge.createThread({cwd:'.',name:'name'}),{code:'CODEX_THREAD_CREATE_UNCERTAIN'});
  assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
});

test('disconnecting Rin leaves the shared server available to another client', async t => {
  const {bridge,options,calls}=await peer(t);
  await bridge.queue('id',{text:'one'});await bridge.stop();
  const next=new CodexBridge(options);await next.start();t.after(()=>next.stop());
  await next.queue('id',{text:'two'});
  assert.equal(calls.filter(x=>x.method==='turn/start').length,2);
});

test('parallel connect initializes only once; stop cancels an in-flight request', async t => {
  const {bridge,calls}=await peer(t,(m)=>m.method==='turn/start');
  await Promise.all([bridge.server.connect(),bridge.server.connect()]);
  assert.equal(calls.filter(x=>x.method==='initialize').length,1);
  const p=assert.rejects(bridge.queue('id',{text:'hang'}),/closed/);
  while(!calls.some(x=>x.method==='turn/start')) await new Promise(r=>setTimeout(r,5));
  await bridge.stop();await p;
});

test('missing default listener starts native app-server once with sanitized environment', async t => {
  const dir=await mkdtemp('/tmp/rin-daemon-');t.after(()=>rm(dir,{recursive:true,force:true}));
  const script=join(dir,'start.mjs'), log=join(dir,'log.json');
  await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,nerve:process.env.NERVE_API_TOKEN}));process.exit(9);`);
  const old=process.env.NERVE_API_TOKEN;process.env.NERVE_API_TOKEN='private';t.after(()=>{if(old===undefined)delete process.env.NERVE_API_TOKEN;else process.env.NERVE_API_TOKEN=old;});
  const c=new CodexAppServer({codexHome:dir,command:[process.execPath,script],queueTimeoutMs:200});t.after(()=>c.stop());
  await assert.rejects(c.connect());
  assert.deepEqual(JSON.parse(await readFile(log,'utf8')),{args:['app-server','--listen','unix://'],home:dir});
});

test('Codex chat adapter never starts a missing app-server', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-agent-no-bootstrap-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const marker=join(dir,'started'),script=join(dir,'must-not-start.mjs');
  await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');`);
  const bridge=new CodexBridge({codexHome:dir,command:[process.execPath,script],queueTimeoutMs:200});
  await bridge.start();t.after(()=>bridge.stop());
  await assert.rejects(bridge.queue('thread',{text:'hello'}));
  await assert.rejects(readFile(marker),{code:'ENOENT'});
  await assert.rejects(bridge.createThread({cwd:dir}),{code:'CODEX_THREAD_CREATE_FAILED'});
  await assert.rejects(readFile(marker),{code:'ENOENT'});
});

test('custom endpoint failures do not bootstrap a second server', async t => {
  const dir=await mkdtemp(join(tmpdir(),'rin-no-fallback-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const c=new CodexAppServer({endpoint:`unix://${dir}/missing.sock`,command:['must-not-run']});t.after(()=>c.stop());
  await assert.rejects(c.connect(),{code:'ENOENT'});
});
