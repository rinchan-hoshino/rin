import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatStore} from '../src/chat/store.mjs';
import {AttentionClient} from '../src/chat/attention-client.mjs';

test('attention forwarding survives failure and restart without losing stable identities',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rin-attention-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'nerve.json'),JSON.stringify({port:9761}));
 writeFileSync(join(dir,'secrets.json'),JSON.stringify({NERVE_TOKEN:'test-token-123456789012345678901234'}));
 let store=new ChatStore(join(dir,'chat.sqlite'));
 const client=new AttentionClient(join(dir,'nerve.json'),store,{fetchImpl:async()=>{throw Error('offline');}});
 client.observe({id:'once',text:'message'});client.observe({id:'once',text:'replay'});
 await assert.rejects(client.flush(),/offline/);store.close();
 store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>store.close());
 const sent=[];
 const restarted=new AttentionClient(join(dir,'nerve.json'),store,{fetchImpl:async(url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};}});
 await restarted.flush();await restarted.flush();
 assert.deepEqual(sent,[{id:'once',text:'message'}]);
});

test('stopping attention forwarding aborts its request and leaves the message pending',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'rin-attention-stop-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'nerve.json'),JSON.stringify({port:9761}));writeFileSync(join(dir,'secrets.json'),JSON.stringify({NERVE_TOKEN:'test-token-123456789012345678901234'}));
 const store=new ChatStore(join(dir,'chat.sqlite'));t.after(()=>store.close());
 const client=new AttentionClient(join(dir,'nerve.json'),store,{fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}))});
 client.observe({id:'pending'});const active=client.flush();client.stop();await assert.rejects(active,/stopped/);
 assert.equal(client.busy,false);assert.equal(store.db.prepare('SELECT state FROM attention_outbox').get().state,'pending');
 await client.flush();
});
