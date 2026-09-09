import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm,realpath,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebSocketServer} from 'ws';
import {ensureAppServer,prepareAppServerRestart} from '../dist/codex-server-lifecycle.js';
import {main} from '../dist/cli.js';

async function unixPeer(t) {
  const home=await mkdtemp('/tmp/rin-as-test-');
  await mkdir(join(home,'app-server-control'));
  const path=join(home,'app-server-control/app-server-control.sock');
  const server=createServer();const wss=new WebSocketServer({server});
  wss.on('connection',ws=>ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.id)ws.send(JSON.stringify({id:m.id,result:{codexHome:home}}));}));
  server.listen(path);await once(server,'listening');
  t.after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});});
  return {home,path,options:{codexHome:home,queueTimeoutMs:300},canonical:await realpath(path)};
}
const posix={skip:process.platform==='win32'};
const socketTable=(rows)=>'Address Type Recv-Q Send-Q Inode Conn Refs Nextref rxbytes txbytes rhiwat shiwat process:pid state options gencnt flags flags1 usecnt rtncnt fltrs Addr\n'+rows.map(([pid,path])=>`1 stream 0 0 2 0 0 0 0 0 8192 8192 codex:${pid} 00100 00000002 1 1 0 1 0 0 ${path}`).join('\n');

test('startup waits for a real handshake and disconnect leaves server running',posix,async t=>{
  const p=await unixPeer(t);
  await ensureAppServer(p.options);
  await ensureAppServer(p.options);
});

test('restart signals only the verified socket owner, after preparation, then reconnects',posix,async t=>{
  const p=await unixPeer(t),events=[];
  let alive=true;
  const run=async(command,args)=>command==='ps'?'101 1 501 /usr/bin/codex app-server --listen unix://\n102 1 501 /usr/bin/codex app-server --listen unix://\n900 1 501 node rin restart --app-server':socketTable([[101,p.canonical],[102,'/tmp/another.sock']]);
  const restart=await prepareAppServerRestart(p.options,{platform:'darwin',uid:501,pid:900,run,kill:(pid,signal)=>{
    assert.equal(pid,101);if(signal==='SIGTERM'){events.push('term');alive=false;return true;}
    if(!alive)throw Object.assign(new Error('gone'),{code:'ESRCH'});return true;
  },ensure:async()=>events.push('ready')});
  assert.deepEqual(events,[]);await restart();assert.deepEqual(events,['term','ready']);
});

for(const mode of ['ambiguous','different user','self','changed'])test(`restart refuses ${mode} without signalling`,posix,async t=>{
  const p=await unixPeer(t);let scans=0,signals=0;
  const run=async command=>{
    if(command==='ps')return `101 1 ${mode==='different user'?502:501} /usr/bin/codex app-server --listen unix://\n102 1 501 /usr/bin/codex app-server --listen unix://\n900 ${mode==='self'?101:1} 501 node rin restart --app-server`;
    scans++;return mode==='ambiguous'?socketTable([[101,p.canonical],[102,p.canonical]]):socketTable([[mode==='changed'&&scans>1?102:101,p.canonical]]);
  };
  await assert.rejects(async()=>{const restart=await prepareAppServerRestart(p.options,{platform:'darwin',uid:501,pid:900,run,kill:()=>{signals++;return true;}});await restart();});
  assert.equal(signals,0);
});

test('a missing default server starts without looking up or stopping a PID',posix,async t=>{
  const home=await mkdtemp('/tmp/rin-as-missing-');t.after(()=>rm(home,{recursive:true,force:true}));let ready=0;
  const restart=await prepareAppServerRestart({codexHome:home},{platform:'darwin',run:async()=>{throw Error('must not inspect');},kill:()=>{throw Error('must not signal');},ensure:async()=>{ready++;}});
  await restart();assert.equal(ready,1);
});

test('custom endpoints are rejected before any shutdown',async()=>{
  await assert.rejects(prepareAppServerRestart({endpoint:'ws://example.com:4500'}),/default local endpoint/);
});

async function installation(t) {
  const home=await mkdtemp(join(tmpdir(),'rin-cli-life-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(join(home,'private'));
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',current:'a'.repeat(40),node:process.execPath,repository:'/unused',codexHome:home}));
  await writeFile(join(home,'private/daemon.json'),JSON.stringify({nerve:'nerve.json'}));
  return home;
}
test('Rin service lifecycle never touches the agent endpoint',async t=>{
  const home=await installation(t),events=[];
  const options={home,codex:process.execPath,serviceFactory:()=>({start:async()=>events.push('rin.start'),stop:async()=>events.push('rin.stop')}),ensureServer:async()=>events.push('server.ready')};
  await main(['start'],options);await main(['stop'],options);
  assert.deepEqual(events,['rin.start','rin.stop']);
});
test('explicit app-server restart does not stop or start Rin',async t=>{
  const home=await installation(t),events=[];
  await main(['app-server','restart'],{home,codex:process.execPath,serviceFactory:()=>({start:async()=>events.push('rin.start'),stop:async()=>events.push('rin.stop')}),prepareServerRestart:async()=>{events.push('preflight');return async()=>events.push('server.restart');}});
  assert.deepEqual(events,['preflight','server.restart']);
});
test('failed explicit app-server start does not launch Rin service',async t=>{
  const home=await installation(t);let started=false;
  await assert.rejects(main(['app-server','start'],{home,codex:process.execPath,serviceFactory:()=>({start:async()=>{started=true;}}),ensureServer:async()=>{throw Error('handshake failed');}}),/handshake failed/);
  assert.equal(started,false);
});
