import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {CodexBridge} from '../dist/chat/codex.js';
const waitFor=async fn=>{for(let i=0;i<400;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('observer timeout');};
const answer=(id,text,extra={})=>({id,type:'agentMessage',text,phase:'final_answer',...extra});
async function fixture(t,turns=[]) {
 const wss=new WebSocketServer({host:'127.0.0.1',port:0});await once(wss,'listening');
 const f={turns,events:[],saved:undefined,calls:[],offline:false,bridges:[]};
 wss.on('connection',ws=>ws.on('message',raw=>{
  const m=JSON.parse(String(raw));if(!m.id)return;f.calls.push(m.method);
  if(f.offline){ws.terminate();return;}
  let result={};
  if(m.method==='thread/turns/list'||m.method==='thread/items/list'){
   assert.equal(m.params.threadId,'thread');
   const rows=m.method==='thread/turns/list'?[...f.turns].reverse().map(({items,...x})=>x):(f.turns.find(t=>t.id===m.params.turnId)?.items||[]).map(item=>({turnId:m.params.turnId,item}));
   const offset=Number(m.params.cursor||0),end=offset+m.params.limit;
   result={data:rows.slice(offset,end),nextCursor:end<rows.length?String(end):null};
  }else if(m.method!=='initialize')assert.fail(`unexpected RPC ${m.method}`);
  ws.send(JSON.stringify({id:m.id,result}));
 }));
 f.make=()=>{const b=new CodexBridge({endpoint:`ws://127.0.0.1:${wss.address().port}`,codexHome:'/does-not-exist',pollMs:10,onEvent:e=>f.events.push(e),getCursor:()=>f.saved,setCursor:(_k,v)=>{f.saved=structuredClone(v);}});f.bridges.push(b);return b;};
 t.after(async()=>{for(const b of f.bridges)await b.stop();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));});
 return f;
}

test('API observer baselines old history and emits public updates before completion without local databases',async t=>{
 const f=await fixture(t,[{id:'old',status:'completed',items:[answer('old','old')]}]);const b=f.make();await b.start();await b.watch('thread');assert.deepEqual(f.events,[]);
 f.turns.push({id:'new',status:'inProgress',items:[{id:'tool',type:'commandExecution',aggregatedOutput:'secret'}, {id:'reason',type:'reasoning',summary:['old summary','public summary'],content:['private reasoning']},answer('a','Work',{phase:'commentary'})]});
 await waitFor(()=>f.events.some(e=>e.text==='Work'));assert.equal(JSON.stringify(f.events).includes('secret'),false);assert.equal(JSON.stringify(f.events).includes('private reasoning'),false);
 f.turns[1].items[2].text='Working';await waitFor(()=>f.events.some(e=>e.text==='Working'));
 f.turns[1].status='completed';await waitFor(()=>f.events.at(-1)?.type==='completed');
 assert.ok(f.events.find(e=>e.text==='public summary'&&e.phase==='summary'));assert.ok(!f.calls.includes('thread/resume'));
});

test('persistent API checkpoint recovers a missed final and does not replay it on another restart',async t=>{
 const f=await fixture(t,[{id:'active',status:'inProgress',items:[]}]);let b=f.make();await b.start();await b.watch('thread');await b.stop();
 f.turns[0].items.push(answer('final','done'));f.turns[0].status='completed';b=f.make();await b.start();await b.watch('thread');assert.equal(f.events.filter(e=>e.text==='done').length,1);assert.equal(f.events.at(-1).type,'completed');await b.stop();
 b=f.make();await b.start();await b.watch('thread');assert.equal(f.events.filter(e=>e.text==='done').length,1);
});

test('all missed turn and item pages are consumed in canonical order with steer boundaries first',async t=>{
 const f=await fixture(t,[{id:'anchor',status:'completed',items:[]}]);let b=f.make();await b.start();await b.watch('thread');await b.stop();
 for(let i=0;i<205;i++)f.turns.push({id:`t${i}`,status:'completed',items:[answer(`a${i}`,`answer${i}`)]});
 const active={id:'active',status:'inProgress',items:Array.from({length:105},(_,i)=>({id:`tool${i}`,type:'commandExecution'}))};
 active.items.push(answer('old','old output'),{id:'input',type:'userMessage',clientId:'receipt'},answer('new','new output'));f.turns.push(active);
 b=f.make();await b.start();await b.watch('thread');assert.equal(f.events.filter(e=>e.type==='completed').length,205);
 const events=f.events.filter(e=>e.turnId==='active');assert.equal(events[1].type,'input');assert.equal(events[1].ordinal,106);assert.equal(events.find(e=>e.itemId==='old').ordinal,105);assert.equal(events.find(e=>e.itemId==='new').ordinal,107);
});

test('disconnect retains checkpoint and recovers without submitting or resuming a model turn',async t=>{
 const f=await fixture(t,[{id:'a',status:'inProgress',items:[]}]);const b=f.make();await b.start();await b.watch('thread');f.offline=true;
 await waitFor(()=>f.events.some(e=>e.type==='observerError'));f.offline=false;f.turns[0].items.push(answer('a','recovered'));f.turns[0].status='completed';
 await waitFor(()=>f.events.some(e=>e.type==='observerReady'));assert.equal(f.events.filter(e=>e.text==='recovered').length,1);assert.ok(f.calls.every(m=>['initialize','thread/turns/list','thread/items/list'].includes(m)));
});

test('images, asynchronous questions and failed turns keep their public semantics',async t=>{
 const f=await fixture(t);const b=f.make();await b.start();await b.watch('thread');
 f.turns.push({id:'x',status:'failed',error:{message:'failed'},items:[answer('q','question',{delivery:'async'}),{id:'img',type:'imageGeneration',status:'completed',savedPath:'/tmp/image.png'}]});
 await waitFor(()=>f.events.at(-1)?.type==='failed');assert.equal(f.events.find(e=>e.itemId==='q').phase,'question');assert.equal(f.events.find(e=>e.type==='image').path,'/tmp/image.png');assert.equal(f.events.at(-1).text,'failed');
});

test('legacy active checkpoint is recovered through the API with a fresh ordering baseline',async t=>{
 const f=await fixture(t,[{id:'active',status:'completed',items:[{id:'input',type:'userMessage',clientId:'old-receipt'},answer('final','finished offline')]}]);
 f.saved={version:1,turnHighWater:10,itemHighWater:20,activeTurns:[{turnId:'active',status:'inProgress'}]};const b=f.make();await b.start();await b.watch('thread');
 assert.equal(f.events[0].type,'orderReset');assert.equal(f.events.find(e=>e.type==='input').ordinal,0);assert.equal(f.events.at(-1).type,'completed');assert.equal(f.saved.version,2);
});
