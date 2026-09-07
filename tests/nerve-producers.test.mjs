import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,Nerve,makeServer} from '../dist/nerve.js';
import {emitEvent} from '../dist/nerve-emit.js';
import {ScriptDirectory} from '../dist/nerve-scripts.js';
import {submitEvent} from '../dist/codex-input-command.js';
test('producer helper verifies durable queue admission and rejects wrong credentials',async t=>{
 const store=new Store(':memory:');const n=new Nerve({targets:{out:{type:'command',argv:['true']}}},store);const token='test-token-at-least-24-characters';const server=makeServer(n,token);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 t.after(async()=>{await new Promise(ok=>server.close(ok));store.close();});
 const options={endpoint:`http://127.0.0.1:${server.address().port}`,token};const event={id:'x',target:'out',payload:{prompt:'x'}};
 assert.deepEqual(await emitEvent(event,options),{id:'x',inserted:true});assert.deepEqual(await emitEvent(event,options),{id:'x',inserted:false});
 await assert.rejects(emitEvent({...event,payload:{prompt:'changed'}},options),/400/);await assert.rejects(emitEvent(event,{...options,token:'wrong'}),/401/);
});
test('script directory passes admission credentials and drains child shutdown',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'nerve-scripts-'));const output=join(dir,'receipt.json');
 writeFileSync(join(dir,'source.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({endpoint:process.env.NERVE_ENDPOINT,token:process.env.NERVE_TOKEN}));setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(output+'.closed')},'closed');process.exit(0);});`);
 const scripts=new ScriptDirectory(dir,{NERVE_ENDPOINT:'http://127.0.0.1:1',NERVE_TOKEN:'fixture'},()=>{});t.after(async()=>{await scripts.stop();rmSync(dir,{recursive:true,force:true});});await scripts.start();
 for(let n=0;n<100&&!existsSync(output);n++)await new Promise(ok=>setTimeout(ok,10));
 assert.deepEqual(JSON.parse(readFileSync(output)),{endpoint:'http://127.0.0.1:1',token:'fixture'});await scripts.stop();
 if(process.platform!=='win32')assert.equal(readFileSync(output+'.closed','utf8'),'closed');
});
test('input adapter returns at admission; pre-submit errors differ from uncertain submissions',async()=>{
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',event={id:'source:1',payload:{prompt:'hello'}};
 let stopped=0;const bridge={start:async()=>{},stop:async()=>stopped++,queue:async(thread,input)=>{assert.equal(thread,id);assert.match(input.text,/source:1/);input.onClientMessageId('client');return{threadId:id,messageId:'client',turnId:'turn'};}};
 assert.equal((await submitEvent(id,event,bridge)).accepted,true);
 bridge.queue=async()=>{throw new Error('owner unavailable');};assert.equal((await submitEvent(id,event,bridge)).retryable,true);
 bridge.queue=async(_,input)=>{input.onClientMessageId('client');throw new Error('connection closed');};assert.equal((await submitEvent(id,event,bridge)).retryable,false);assert.equal(stopped,3);
});
