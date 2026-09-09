import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,symlinkSync,mkdirSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBridge } from '../dist/chat/bridge.js';
import { outputFiles } from '../dist/chat/files.js';

test('durable ingress queues once; commentary edits same remote message; tool events are suppressed',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-'));const sent=[],queued=[],deleted=[];
  let receive;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async(t,m)=>{queued.push([t,m]);return {messageId:'q1'};}};
  const adapter={capabilities:{edit:true,typing:true,maxText:2000},start:async(fn)=>{receive=fn;},stop:async()=>{},typing:async()=>{},delete:async(_target,id)=>{deleted.push(id);},send:async(t,o)=>{sent.push(o);return {id:o.editId || `remote-${sent.length}`};}};
  const config={dataDir,adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'t',mirror:true}]};
  const b=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await b.start();
    const m={id:'m',chatId:'dm',userId:'owner',kind:'dm',text:'hi'};
    await receive(m);await new Promise(r=>setImmediate(r));await receive(m);await b.submit();assert.equal(queued.length,1);
    b.event({threadId:'t',turnId:'turn',type:'text',itemId:'i',phase:'commentary',text:'working'});await b.flush();
    b.event({threadId:'t',turnId:'turn',type:'tool',text:'secret tool output'});await b.flush();assert.equal(sent.length,1);
    b.event({threadId:'t',turnId:'turn',type:'text',itemId:'i',phase:'commentary',text:'working more'});await b.flush();
    assert.equal(sent[1].editId,'remote-1');assert.equal(sent[1].text,'... Working...\n\n────────\n\nworking more');
    b.event({threadId:'t',turnId:'turn',type:'text',itemId:'final',phase:'final_answer',text:'finished'});await b.flush();
    assert.equal(sent[2].text,'finished');assert.equal(sent[2].editId,undefined);assert.deepEqual(deleted,['remote-1']);
    b.event({threadId:'other',type:'text',itemId:'x',phase:'final',text:'wrong thread'});await b.flush();assert.equal(sent.length,3);
  }finally{await b.stop();rmSync(dataDir,{recursive:true});}
});

test('idle failed admission types once, reports once through the outbox, and never becomes active',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-submit-failed-'));const sent=[],typing=[];let receive;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>{throw new Error('lost response');}};
  const adapter={capabilities:{edit:true,typing:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},
    typing:async()=>{typing.push('typing');},send:async(_target,output)=>{sent.push(output);return {id:`remote-${sent.length}`};}};
  const config={dataDir,adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();const message={id:'source',chatId:'dm',userId:'owner',kind:'dm',text:'hello'};
    await receive(message);await new Promise(resolve=>setImmediate(resolve));await bridge.flush();
    assert.equal(typing.length,1,'admission may show one immediate typing hint');
    bridge.typing();bridge.typing();assert.equal(typing.length,1,'failed idle submission must not sustain typing');
    assert.deepEqual(sent,[{text:'lost response',replyTo:'source',target:{chatId:'dm',kind:'dm',userId:'owner',messageId:'source'}}]);
    await receive(message);await bridge.submit();await bridge.flush();assert.equal(sent.length,1,'replayed ingress must not duplicate the error reply');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('submission failure preserves an existing active turn, queue stays idle, and app-server turn receipts become active',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-active-submit-'));const typing=[];let receive,release,mode='pending';
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>{
    if(mode==='failed')throw new Error('submission failed');
    if(mode==='pending')return new Promise(resolve=>{release=()=>resolve({messageId:'queued'});});
    return mode==='steered'?{transport:'app-server',turnId:'steered-turn'}
      : mode==='started'?{transport:'app-server',turnId:'started-turn'}:{messageId:'queued'};
  }};
  const adapter={capabilities:{edit:false,typing:true,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},typing:async()=>{typing.push('typing');},send:async()=>({id:'reply'})};
  const config={dataDir,adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();
    await receive({id:'queued',chatId:'dm',userId:'owner',kind:'dm',text:'queued'});await new Promise(resolve=>setImmediate(resolve));
    const whilePending=typing.length;bridge.lastTypingAt.clear();bridge.typing();assert.equal(typing.length,whilePending,'a pending submission must not claim the turn is running');
    mode='queued';release();await new Promise(resolve=>setImmediate(resolve));
    const afterQueued=typing.length;bridge.lastTypingAt.clear();bridge.typing();assert.equal(typing.length,afterQueued,'a queue receipt must not claim the turn is running');
    bridge.event({threadId:'thread',turnId:'real-turn',type:'started'});const afterStarted=typing.length;
    mode='failed';await receive({id:'failed',chatId:'dm',userId:'owner',kind:'dm',text:'more'});await new Promise(resolve=>setImmediate(resolve));
    bridge.lastTypingAt.clear();bridge.typing();assert.equal(typing.length,afterStarted+2,'a failed submission must preserve a separately confirmed active turn');
    bridge.event({threadId:'thread',turnId:'real-turn',type:'completed'});
    mode='steered';await receive({id:'steered',chatId:'dm',userId:'owner',kind:'dm',text:'steer'});await new Promise(resolve=>setImmediate(resolve));
    const afterSteer=typing.length;bridge.lastTypingAt.clear();bridge.typing();assert.equal(typing.length,afterSteer+1,'a successful steer confirms sustained activity');
    assert.equal(bridge.store.db.prepare("SELECT state FROM inbox WHERE id=?").get(JSON.stringify(['d','dm','steered'])).state,'delivered');
    bridge.event({threadId:'thread',turnId:'steered-turn',type:'completed'});
    mode='started';await receive({id:'started',chatId:'dm',userId:'owner',kind:'dm',text:'start'});await new Promise(resolve=>setImmediate(resolve));
    const afterStart=typing.length;bridge.lastTypingAt.clear();bridge.typing();assert.equal(typing.length,afterStart+1,'a successful app-server start confirms sustained activity');
    assert.equal(bridge.store.db.prepare("SELECT state FROM inbox WHERE id=?").get(JSON.stringify(['d','dm','started'])).state,'delivered');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('explicit unsupported Codex input preserves the original error message',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-unsupported-'));const sent=[];let receive;
  const error=Object.assign(new Error('unsupported'),{code:'CODEX_INPUT_UNSUPPORTED'});
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>{throw error;}};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async fn=>{receive=fn;},stop:async()=>{},send:async(_target,output)=>{sent.push(output);return {id:'reply'};}};
  const config={dataDir,adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();await receive({id:'file',chatId:'dm',userId:'owner',kind:'dm',text:'',files:[{name:'x'}]});
    await new Promise(resolve=>setImmediate(resolve));await bridge.flush();assert.equal(sent[0].text,'unsupported');assert.equal(sent[0].replyTo,'file');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('a shorter projection retains the first remote message and deletes surplus remote chunks',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-retire-'));const calls=[],remote=new Map();let next=1;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'q'})};
  const adapter={capabilities:{edit:true,typing:false,maxText:40},start:async()=>{},stop:async()=>{},
    send:async(_target,output)=>{const id=output.editId || `remote-${next++}`;calls.push(['send',output,id]);remote.set(id,output.text);return {id};},
    delete:async(_target,id)=>{calls.push(['delete',id]);assert.ok(remote.has(id));remote.delete(id);}};
  const config={dataDir,adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'t',mirror:true}]};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();
    bridge.store.setCursor(`reply:${bridge.routeKey(config.bindings[0])}`,{messageId:'source-message'});
    bridge.event({threadId:'t',turnId:'turn',type:'text',itemId:'item',phase:'commentary',text:'abcdefghij'.repeat(12)});await bridge.flush();
    const firstSends=calls.filter(call=>call[0]==='send');
    assert.equal(firstSends[0][1].replyTo,'source-message');
    assert.ok(firstSends.slice(1).every(call=>call[1].replyTo===undefined),'only the first fragment quotes the source message');
    const originalIds=[...remote.keys()];assert.ok(originalIds.length>1);
    const beforeShrink=calls.length;
    bridge.event({threadId:'t',turnId:'turn',type:'text',itemId:'item',phase:'commentary',text:'xy'});await bridge.flush();
    assert.deepEqual([...remote],[[originalIds[0],'... Working...\n\n────────\n\nxy']]);
    const changes=calls.slice(beforeShrink);
    assert.equal(changes[0][1].editId,originalIds[0]);
    assert.deepEqual(changes.filter(call=>call[0]==='delete').map(call=>call[1]),originalIds.slice(1));
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('restart preserves buffered public text until completion on a no-edit transport',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-bridge-buffer-'));const sent=[];
  const config={dataDir,adapters:[{id:'t',type:'telegram',allowUsers:['owner']}],bindings:[{adapter:'t',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const makeCodex=()=>({start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'q'})});
  const makeAdapter=()=>({capabilities:{edit:false,typing:false,maxText:4096},start:async()=>{},stop:async()=>{},
    send:async(_target,output)=>{sent.push(output);return {id:`remote-${sent.length}`};}});
  let first=new ChatBridge(config,{codex:makeCodex(),adapterFactory:async()=>makeAdapter(),log:{info(){},warn(){},error(){}}});
  try{
    await first.start();
    first.event({threadId:'thread',turnId:'turn',type:'text',itemId:'answer',phase:'final_answer',delta:'durable buffered answer'});
    await first.flush();assert.deepEqual(sent,[]);
    assert.equal(first.store.cursor('public-items').length,1);
    await first.stop();first=null;

    const second=new ChatBridge(config,{codex:makeCodex(),adapterFactory:async()=>makeAdapter(),log:{info(){},warn(){},error(){}}});
    try{
      await second.start();
      second.event({threadId:'thread',turnId:'turn',type:'completed'});
      await second.flush();
      assert.deepEqual(sent,[{text:'durable buffered answer',parseMode:'HTML'}]);
      assert.deepEqual(second.store.cursor('public-items'),[]);
    }finally{await second.stop();}
  }finally{
    if(first)await first.stop();
    rmSync(dataDir,{recursive:true});
  }
});


for(const type of ['discord','telegram']) test(`${type}: different public items update one progress message, survive restart, and retire before a fresh final`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),`rin-${type}-progress-`));
  const calls=[],remote=new Map();let nextId=1,bridge;
  const config={dataDir,adapters:[{id:'chat',type,allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const makeBridge=()=>new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'q'})},
    adapterFactory:async()=>({capabilities:{edit:true,typing:false,maxText:4096},start:async()=>{},stop:async()=>{},
      send:async(_target,output)=>{
        const id=output.editId || `remote-${nextId++}`;
        if(output.editId)assert.ok(remote.has(id),'an edit must address an existing remote message');
        remote.set(id,output.text);calls.push({method:output.editId?'edit':'send',id,text:output.text});return {id};
      },
      delete:async(_target,id)=>{assert.ok(remote.has(id));remote.delete(id);calls.push({method:'delete',id});},
    }),log:{info(){},warn(){},error(){}},
  });
  const emit=async(itemId,phase,text)=>{
    bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId,phase,text});await bridge.flush();
  };
  try{
    bridge=makeBridge();await bridge.start();
    await emit('commentary-1','commentary','checking files');
    await emit('commentary-2','commentary','running checks');
    assert.deepEqual(calls.slice(0,2),[
      {method:'send',id:'remote-1',text:'... Working...\n\n────────\n\nchecking files'},
      {method:'edit',id:'remote-1',text:'... Working...\n\n────────\n\nrunning checks'},
    ]);
    await emit('summary-1','summary','first public summary');
    assert.equal(remote.get('remote-1'),'... first public summary\n\n────────\n\nrunning checks');
    await emit('summary-2','summary','**outdated heading**\n\n**latest public summary**');
    assert.equal(remote.get('remote-1'),'... latest public summary\n\n────────\n\nrunning checks');
    assert.equal(remote.size,1);
    await bridge.stop();bridge=null;

    bridge=makeBridge();await bridge.start();
    await emit('commentary-3','commentary','checks passed');
    assert.deepEqual(calls.at(-1),{method:'edit',id:'remote-1',text:'... latest public summary\n\n────────\n\nchecks passed'});
    const beforeFinal=calls.length;
    await emit('answer','final_answer','finished');
    assert.deepEqual(calls.slice(beforeFinal),[
      {method:'delete',id:'remote-1'},
      {method:'send',id:'remote-2',text:'finished'},
    ]);
    assert.deepEqual([...remote],[['remote-2','finished']]);
    const settledCalls=calls.length;
    await emit('late-commentary','commentary','must not revive progress');
    await emit('late-summary','summary','must not revive summary');
    bridge.event({threadId:'thread',turnId:'turn',type:'completed'});await bridge.flush();
    assert.equal(calls.length,settledCalls);
    await bridge.stop();bridge=null;

    bridge=makeBridge();await bridge.start();
    await emit('late-after-restart','commentary','still stale');
    assert.equal(calls.length,settledCalls);
    assert.deepEqual([...remote],[['remote-2','finished']]);
  }finally{if(bridge)await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('artifact links respect real paths and roots',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rin-files-'));const other=mkdtempSync(join(tmpdir(),'rin-outside-'));
  writeFileSync(join(dir,'ok.txt'),'ok');writeFileSync(join(other,'outside.txt'),'outside');symlinkSync(join(other,'outside.txt'),join(dir,'escape.txt'));
  const text=`[ok](${join(dir,'ok.txt')}) [bad](${join(dir,'escape.txt')})`;
  assert.deepEqual(outputFiles(text,[dir]).map(f=>f.name),['ok.txt']);rmSync(dir,{recursive:true});rmSync(other,{recursive:true});
});

for(const type of ['discord','telegram']) test(`${type}: native start immediately presents Working; errors preserve quoted progress; only final withdraws it`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),`rin-${type}-lifecycle-`));
  const calls=[],remote=new Map();let nextId=1,receive;
  const config={dataDir,adapters:[{id:'chat',type,allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'queued'})},
    adapterFactory:async()=>({capabilities:{edit:true,typing:true,maxText:4096},start:async fn=>{receive=fn;},stop:async()=>{},typing:async()=>{calls.push({method:'typing'});},
      send:async(_target,output)=>{const id=output.editId || `remote-${nextId++}`;remote.set(id,output.text);calls.push({method:output.editId?'edit':'send',id,...output});return {id};},
      delete:async(_target,id)=>{assert.ok(remote.has(id));remote.delete(id);calls.push({method:'delete',id});},
    }),log:{info(){},warn(){},error(){}},
  });
  try{
    await bridge.start();
    await receive({id:'source-message',chatId:'dm',userId:'owner',kind:'dm',text:'check it'});
    bridge.event({threadId:'thread',turnId:'turn',type:'started'});await bridge.flush();
    const initial=calls.find(call=>call.method==='send');
    assert.equal(initial.text,'... Working...');assert.equal(initial.replyTo,'source-message');
    assert.ok(calls.some(call=>call.method==='typing'));
    const emit=async(itemId,phase,text)=>{bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId,phase,text});await bridge.flush();};
    await emit('summary','summary','**first summary**\n\n**latest public summary**');
    assert.equal(remote.get(initial.id),'... latest public summary');
    await emit('commentary','commentary','checking files');
    assert.equal(remote.get(initial.id),'... latest public summary\n\n────────\n\nchecking files');
    bridge.event({threadId:'thread',turnId:'turn',type:'failed'});await bridge.flush();
    assert.equal(remote.get(initial.id),'... latest public summary\n\n────────\n\nchecking files');
    assert.equal(calls.filter(call=>call.method==='delete').length,0);
    const error=calls.filter(call=>call.method==='send').at(-1);
    assert.notEqual(error.id,initial.id);assert.equal(error.editId,undefined);assert.match(error.text,/本轮执行未完成/);
    await emit('answer','final_answer','finished');
    assert.equal(remote.has(initial.id),false);
    assert.equal(remote.has(error.id),true,'final must not delete a separate error message');
    const answer=calls.filter(call=>call.method==='send').at(-1);
    assert.equal(answer.text,'finished');assert.equal(answer.replyTo,'source-message');assert.equal(answer.editId,undefined);
    assert.deepEqual(calls.filter(call=>call.method==='delete').map(call=>call.id),[initial.id]);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

for(const type of ['discord','telegram']) test(`${type}: a new turn after an error reuses the quoted progress and preserves its content until replaced`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),`rin-${type}-retry-slot-`));
  const calls=[],remote=new Map();let nextId=1;
  const config={dataDir,adapters:[{id:'chat',type,allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'q'})},
    adapterFactory:async()=>({capabilities:{edit:true,typing:false,maxText:4096},start:async()=>{},stop:async()=>{},
      send:async(_target,output)=>{const id=output.editId || `remote-${nextId++}`;remote.set(id,output.text);calls.push({method:output.editId?'edit':'send',id,...output});return {id};},
      delete:async(_target,id)=>{assert.ok(remote.has(id));remote.delete(id);calls.push({method:'delete',id});},
    }),log:{info(){},warn(){},error(){}},
  });
  const emit=async(turnId,event)=>{bridge.event({threadId:'thread',turnId,...event});await bridge.flush();};
  try{
    await bridge.start();
    bridge.store.setCursor(`reply:${bridge.routeKey(config.bindings[0])}`,{messageId:'same-source'});
    await emit('first',{type:'started'});
    const original=calls.find(call=>call.method==='send');
    await emit('first',{type:'text',itemId:'interim',phase:'commentary',text:'last useful checkpoint'});
    await emit('first',{type:'failed'});
    const error=calls.filter(call=>call.method==='send').at(-1);
    const beforeRetry=calls.length;
    await emit('retry',{type:'started'});
    assert.equal(remote.get(original.id),'... Working...\n\n────────\n\nlast useful checkpoint');
    assert.equal(calls.slice(beforeRetry).filter(call=>call.method==='send').length,0,'resuming the same quote must not create another Working message');
    await emit('retry',{type:'text',itemId:'new-interim',phase:'commentary',text:'new checkpoint'});
    assert.equal(calls.at(-1).method,'edit');assert.equal(calls.at(-1).id,original.id);
    assert.equal(remote.get(original.id),'... Working...\n\n────────\n\nnew checkpoint');
    assert.equal(calls.filter(call=>call.method==='delete').length,0);
    await emit('retry',{type:'text',itemId:'answer',phase:'final',text:'done'});
    assert.deepEqual(calls.filter(call=>call.method==='delete').map(call=>call.id),[original.id]);
    assert.equal(remote.has(error.id),true);
    assert.equal(calls.at(-1).text,'done');assert.equal(calls.at(-1).replyTo,'same-source');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('Discord keeps separate quote slots and a final deletes only its frozen source quote slot',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-discord-quote-slots-'));
  const calls=[],remote=new Map();let nextId=1;
  const config={dataDir,adapters:[{id:'chat',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const bridge=new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({messageId:'q'})},
    adapterFactory:async()=>({capabilities:{edit:true,typing:false,maxText:4096},start:async()=>{},stop:async()=>{},
      send:async(_target,output)=>{const id=output.editId || `remote-${nextId++}`;remote.set(id,output.text);calls.push({method:output.editId?'edit':'send',id,...output});return {id};},
      delete:async(_target,id)=>{assert.ok(remote.has(id));remote.delete(id);calls.push({method:'delete',id});},
    }),log:{info(){},warn(){},error(){}},
  });
  const emit=async(turnId,event)=>{bridge.event({threadId:'thread',turnId,...event});await bridge.flush();};
  try{
    await bridge.start();const replyKey=`reply:${bridge.routeKey(config.bindings[0])}`;
    bridge.store.setCursor(replyKey,{messageId:'quote-a'});
    await emit('turn-a',{type:'started'});
    await emit('turn-a',{type:'text',itemId:'interim-a',phase:'commentary',text:'progress A'});
    const slotA=calls.find(call=>call.method==='send');
    bridge.store.setCursor(replyKey,{messageId:'quote-b'});
    await emit('turn-b',{type:'started'});
    await emit('turn-b',{type:'text',itemId:'interim-b',phase:'commentary',text:'progress B'});
    const slotB=calls.filter(call=>call.method==='send').at(-1);
    assert.notEqual(slotA.id,slotB.id);assert.equal(slotA.replyTo,'quote-a');assert.equal(slotB.replyTo,'quote-b');
    assert.equal(remote.size,2);
    await emit('turn-a',{type:'text',itemId:'answer-a',phase:'final',text:'answer A'});
    assert.deepEqual(calls.filter(call=>call.method==='delete').map(call=>call.id),[slotA.id]);
    assert.equal(remote.get(slotB.id),'... Working...\n\n────────\n\nprogress B');
    const answerA=calls.at(-1);assert.equal(answerA.replyTo,'quote-a','a later input cannot retarget an older turn final');
    await emit('turn-b',{type:'text',itemId:'answer-b',phase:'final',text:'answer B'});
    assert.deepEqual(calls.filter(call=>call.method==='delete').map(call=>call.id),[slotA.id,slotB.id]);
    assert.equal(remote.get(answerA.id),'answer A');assert.equal(calls.at(-1).replyTo,'quote-b');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

for(const type of ['onebot']) test(`${type}: complete public snapshots arrive immediately with prefix, immutable deduplication, native file order and frozen quote`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),`rin-${type}-snapshots-`));
  const file=join(dataDir,'image.png');writeFileSync(file,'image');
  const calls=[];let bridge;
  const config={dataDir,attachmentRoots:[dataDir],adapters:[{id:'chat',type,allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const make=()=>new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({})},adapterFactory:async()=>({
    capabilities:{edit:false,typing:false,maxText:4000},start:async()=>{},stop:async()=>{},
    send:async(target,output)=>{assert.equal(output.editId,undefined);calls.push(output);return {id:`remote-${calls.length}`};},
    delete:async()=>{assert.fail('immutable messages must never be retired');},
  }),log:{info(){},warn(){},error(){}}});
  const emit=async(event)=>{bridge.event({threadId:'thread',turnId:'turn',...event});await bridge.flush();};
  try{
    bridge=make();await bridge.start();bridge.store.setCursor(`reply:${bridge.routeKey(config.bindings[0])}`,{messageId:'source'});
    await emit({type:'started'});assert.equal(calls.length,1);assert.equal(calls.shift().text,'Working...');
    await emit({type:'started'});assert.equal(calls.length,0,'marker is not repeated');
    const comment={type:'text',itemId:'comment',phase:'commentary',text:'**Checking** ~~old~~ files'};
    await emit(comment);assert.equal(calls.length,1);assert.equal(calls[0].text,'... Checking old files');assert.equal(calls[0].replyTo,'source');
    await emit(comment);assert.equal(calls.length,1);
    await emit({...comment,text:'Checked files'});assert.equal(calls.length,2);assert.equal(calls[1].text,'... Checked files');
    await emit({type:'text',itemId:'summary',phase:'summary',text:'**stale**\n\n**Latest summary**'});assert.equal(calls.at(-1).text,'... Latest summary');
    await bridge.stop();bridge=make();await bridge.start();await emit(comment);assert.equal(calls.length,3,'restart/replayed older snapshot does not resend');
    bridge.store.setCursor(`reply:${bridge.routeKey(config.bindings[0])}`,{messageId:'later-input'});
    await emit({type:'text',itemId:'final',phase:'final',text:`**Before**\n\n![image](${file})\n\nAfter`});
    assert.deepEqual(calls.slice(-3).map(o=>o.files?'file':o.text),['Before','file','After']);
    assert.equal(calls.at(-3).replyTo,'source');assert.equal(calls.at(-2).replyTo,undefined);assert.equal(calls.at(-2).files[0].mimeType,'image/png');
    const count=calls.length;await emit({type:'completed'});assert.equal(calls.length,count);
  }finally{if(bridge)await bridge.stop();rmSync(dataDir,{recursive:true});}
});


test('OneBot freezes passive reply context for every queued text/media part across later inputs and restart',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-qq-passive-context-'));
  const file=join(dataDir,'image.png');writeFileSync(file,'image');
  const config={dataDir,attachmentRoots:[dataDir],adapters:[{id:'qq',type:'onebot',allowUsers:['owner'],dmOnly:false}],bindings:[{adapter:'qq',chatId:'group',kind:'group',threadId:'thread',mirror:true}]};
  const calls=[];let bridge;
  const make=()=>new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>({})},
    adapterFactory:async()=>({capabilities:{edit:false,typing:false,maxText:12},start:async()=>{},stop:async()=>{},
      send:async(target,output)=>{calls.push({target,output});return {id:`sent-${calls.length}`};},
    }),log:{info(){},warn(){},error(){}},
  });
  try{
    bridge=make();await bridge.start();const replyKey=`reply:${bridge.routeKey(config.bindings[0])}`;
    bridge.store.setCursor(replyKey,{messageId:'source-a',userId:'owner-a'});
    bridge.event({threadId:'thread',turnId:'turn-a',type:'started'});
    bridge.event({threadId:'thread',turnId:'turn-a',type:'text',itemId:'answer',phase:'final',text:`abcdefghijklmnopqrstuvwx\n\n![image](${file})\n\nTail`});
    assert.ok(bridge.store.outgoing().length>=4,'text splitting and media produce multiple staged parts');
    bridge.store.setCursor(replyKey,{messageId:'source-b',userId:'owner-b'});
    await bridge.stop();bridge=make();await bridge.start();
    bridge.store.setCursor(replyKey,{messageId:'source-c',userId:'owner-c'});
    await bridge.flush();assert.ok(calls.length>=4);
    for(const {target,output} of calls){
      assert.equal(target.chatId,'group');assert.equal(target.kind,'group');assert.equal(output.editId,undefined);
    }
    assert.equal(calls[0].output.replyTo,'source-a');
    const answerCalls=calls.filter(({output})=>output.text!=='Working...');
    assert.equal(answerCalls[0].output.replyTo,'source-a');
    assert.ok(answerCalls.slice(1).every(({output})=>output.replyTo===undefined),'passive reply context does not add repeated visible quote segments');
    assert.ok(calls.some(({output})=>output.files?.[0]?.name==='image.png'));
    const count=calls.length;await bridge.flush();assert.equal(calls.length,count,'sent parts are not replayed');
  }finally{if(bridge)await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('Working fallback is plain, quoted, durable and absent with edit or reaction',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'rin-working-fallback-'));const calls=[];let bridge;
 const config={dataDir,adapters:[{id:'qq',type:'onebot',allowUsers:['owner']}],bindings:[{adapter:'qq',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
 const adapter={capabilities:{edit:false,typing:false},start:async()=>{},stop:async()=>{},send:async(target,output)=>{calls.push({target,output});return{id:String(calls.length)};}};
 const make=()=>new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
 try{
  bridge=make();await bridge.start();const binding=config.bindings[0],context={messageId:'source',userId:'owner'};
  bridge.store.setCursor(`reply:${bridge.routeKey(binding)}`,context);
  bridge.stageWorkingMarker(binding,'turn',context);bridge.event({threadId:'thread',turnId:'turn',type:'started'});await bridge.flush();
  assert.equal(calls.length,1);assert.equal(calls[0].output.text,'Working...');assert.equal(calls[0].output.replyTo,'source');
  await bridge.stop();bridge=make();await bridge.start();bridge.event({threadId:'thread',turnId:'turn',type:'started'});await bridge.flush();assert.equal(calls.length,1);
  bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'final',phase:'final',text:'done'});await bridge.flush();
  bridge.stageWorkingMarker(binding,'turn',{messageId:'late'});await bridge.flush();assert.equal(calls.length,2);
  for(const capability of ['edit','reaction']){adapter.capabilities[capability]=true;bridge.stageWorkingMarker(binding,'another',context);await bridge.flush();assert.equal(calls.length,2);adapter.capabilities[capability]=false;}
 }finally{await bridge?.stop();rmSync(dataDir,{recursive:true});}
});

for(const type of ['discord','telegram','onebot'])test(`${type}: questions stay independent while commentary continues, including after restart`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-question-'));
  const editable=['discord','telegram'].includes(type),remote=new Map(),calls=[];
  let nextId=0,b;
  const config={dataDir,adapters:[{id:'chat',type,allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'t',mirror:true}]};
  const make=()=>new ChatBridge(config,{
    codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},
    adapterFactory:async()=>({capabilities:{edit:editable,typing:false,maxText:4000},start:async()=>{},stop:async()=>{},
      send:async(_target,output)=>{const id=output.editId||String(++nextId);remote.set(id,output.text);calls.push(output);return{id};},
      delete:async(_target,id)=>remote.delete(id),
    }),log:{info(){},warn(){},error(){}},
  });
  const emit=async(itemId,phase,text)=>{b.event({threadId:'t',turnId:'turn',type:'text',itemId,phase,text});await b.flush();};
  try{
    b=make();await b.start();
    await emit('before','commentary','before the question');
    await emit('question','question','Which permission?');
    assert.ok([...remote.values()].some(text=>text.includes('before the question')));
    assert.equal([...remote.values()].filter(text=>text==='Which permission?').length,1);
    assert.equal(b.finalizedTurns.has(JSON.stringify(['t','turn'])),false);
    await b.stop();b=make();await b.start();
    const count=calls.length;await emit('question','question','Which permission?');assert.equal(calls.length,count,'question replay is deduplicated');
    await emit('after','commentary','after the question');
    assert.ok([...remote.values()].some(text=>text.includes('after the question')));
    assert.equal([...remote.values()].filter(text=>text==='Which permission?').length,1);
    if(editable){
      const timeline=[...remote.values()];
      assert.ok(timeline[0].includes('before the question'),'old progress stays frozen above question');
      assert.equal(timeline[1],'Which permission?');
      assert.ok(timeline[2].includes('after the question'),'new progress is below question');
      assert.equal(calls.at(-1).editId,undefined,'first progress after question creates a fresh message');
      await b.stop();b=make();await b.start();
      const replayCount=calls.length;
      await emit('question','question','Which permission?');assert.equal(calls.length,replayCount);
      await emit('after2','commentary','later progress');
      assert.equal(calls.at(-1).editId,'3','restart and replay preserve active segment');
      assert.ok([...remote.values()][0].includes('before the question'));
    }
    await emit('final','final','finished');b.event({threadId:'t',turnId:'turn',type:'completed'});await b.flush();
    assert.ok([...remote.values()].includes('finished'));
    assert.equal([...remote.values()].filter(text=>text==='Which permission?').length,1);
    if(editable){
      assert.equal([...remote.values()].some(text=>text.includes('after the question')),false);
      assert.equal([...remote.values()].some(text=>text.includes('before the question')),false);
      assert.deepEqual([...remote.values()],['Which permission?','finished'],'true final removes every progress segment but keeps question');
    }
    const settled=calls.length;await emit('late','commentary','late');assert.equal(calls.length,settled);
  }finally{await b?.stop();rmSync(dataDir,{recursive:true});}
});

test('completed App images use agent-scoped artifacts and durable OneBot reply delivery',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-generated-image-')),sent=[];
  const home=join(dataDir,'home'),root=join(home,'generated_images','t');mkdirSync(root,{recursive:true});
  const path=join(root,'result.png');writeFileSync(path,'image fixture');
  const outside=join(dataDir,'private.png');writeFileSync(outside,'private');symlinkSync(outside,join(root,'escape.png'));
  const config={dataDir,attachmentRoots:[root],adapters:[{id:'q',type:'onebot',allowUsers:['owner']}],bindings:[{adapter:'q',chatId:'g',kind:'group',threadId:'t',mirror:true}]};
  const adapter={capabilities:{edit:false,maxText:2000},start:async()=>{},stop:async()=>{},send:async(_t,o)=>{sent.push(o);return{id:'sent-image'};}};
  const deps={codex:{start:async()=>{},stop:async()=>{},watch(){}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}};
  let bridge=new ChatBridge(config,deps);await bridge.start();
  try{
    const route=bridge.routeKey(config.bindings[0]);bridge.store.setCursor(`turn-reply:${route}:turn`,{messageId:'original',userId:'owner'});
    const event={type:'image',threadId:'t',turnId:'turn',itemId:'image',path};
    bridge.event({...event,path:outside});bridge.event({...event,path:join(root,'escape.png')});await bridge.flush();assert.equal(sent.length,0);
    bridge.event(event);await bridge.flush();assert.equal(sent.length,1);assert.equal(sent[0].files[0].path,realpathSync(path));assert.equal(sent[0].replyTo,'original');assert.equal(sent[0].target.messageId,'original');
    await bridge.stop();bridge=new ChatBridge(config,deps);await bridge.start();bridge.event(event);await bridge.flush();assert.equal(sent.length,1);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

for(const [type,edit] of [['discord',true],['onebot',false]]) test(`${type}: an accepted same-turn steer gets an independent presentation without stealing an old item`,async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),`rin-steer-presentation-${type}-`));const sent=[];let receive,call=0;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>++call===1
    ? {transport:'app-server',turnId:'physical',messageId:'start-client'}
    : {transport:'app-server',turnId:'physical',messageId:'steer-client'}};
  const adapter={capabilities:{edit,typing:false,maxText:2000},start:async handler=>{receive=handler;},stop:async()=>{},
    send:async(target,output)=>{sent.push({target,output});return{id:output.editId || `remote-${sent.length}`};},delete:async()=>{}};
  const config={dataDir,adapters:[{id:'chat',type,allowUsers:['owner-a','owner-b'],requireMention:false}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  let bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();
    await receive({id:'A',chatId:'dm',userId:'owner-a',kind:'dm',text:'first'});await bridge.submit();
    bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-a',clientMessageId:'start-client',ordinal:1});
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'old',phase:'commentary',text:'A progress',ordinal:10});await bridge.flush();
    await receive({id:'B',chatId:'dm',userId:'owner-b',kind:'dm',text:'steer'});await new Promise(resolve=>setImmediate(resolve));await bridge.submit();await bridge.flush();
    assert.ok(sent.some(({output})=>output.replyTo==='B' && (output.progress || output.text==='Working...')),`accepted steer creates B working: calls=${call} sent=${JSON.stringify(sent)}`);
    // This old item is observed after the receipt but was born before B's
    // persisted input boundary, so it remains attached to A.
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'old-final',phase:'final',text:'A final',ordinal:11});await bridge.flush();
    assert.equal(sent.some(({output})=>output.text==='A final'),false,'receipt-first output waits for the persisted input boundary');
    bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-b',clientMessageId:'steer-client',ordinal:20});
    await bridge.flush();assert.ok(sent.some(({output})=>output.text==='A final' && output.replyTo==='A'));
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'new',phase:'final',text:'B final',ordinal:21});await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='B final' && output.replyTo==='B'));
    assert.ok(sent.some(({target,output})=>output.text==='B final' && target.messageId==='B'));
    await bridge.stop();bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});await bridge.start();
    const count=sent.length;
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'old-final',phase:'final',text:'A final',ordinal:11});await bridge.flush();
    assert.equal(sent.length,count,'restart keeps the old item ownership and delivery dedupe');
  }finally{await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('steer persists an input boundary seen before its receipt and defers later same-poll output until it can be attributed',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-steer-input-race-'));const sent=[];let receive,call=0;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>++call===1
    ? {transport:'app-server',turnId:'physical',messageId:'start-client'}
    : {transport:'app-server',turnId:'physical',messageId:'steer-client'}};
  const config={dataDir,adapters:[{id:'chat',type:'discord',allowUsers:['owner'],requireMention:false}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async handler=>{receive=handler;},stop:async()=>{},send:async(target,output)=>{sent.push({target,output});return{id:String(sent.length)};}};
  let bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();await receive({id:'A',chatId:'dm',userId:'owner',kind:'dm',text:'A'});await bridge.submit();
    bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-a',clientMessageId:'start-client',ordinal:1});
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'old',phase:'final',text:'old',ordinal:10});await bridge.flush();
    bridge.expectInput(config.bindings[0],'steer-client');
    bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-b',clientMessageId:'steer-client',ordinal:20});
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'new',phase:'final',text:'new',ordinal:21});await bridge.flush();
    assert.equal(sent.some(({output})=>output.text==='new'),false,'unmatched input boundary defers output rather than assigning it to A');
    await receive({id:'B',chatId:'dm',userId:'owner',kind:'dm',text:'B'});await bridge.submit();await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='new' && output.replyTo==='B'));
    await bridge.stop();bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});await bridge.start();
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'after-restart',phase:'final',text:'after restart',ordinal:22});await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='after restart' && output.replyTo==='B'),'persisted boundary retains B ownership after restart');
  }finally{await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('completed output buffered before a late steer receipt retains question, text, and generated image',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-steer-terminal-race-')),home=join(dataDir,'home'),imageRoot=join(home,'generated_images','thread');mkdirSync(imageRoot,{recursive:true});
  const image=join(imageRoot,'result.png');writeFileSync(image,'pixels');const sent=[];let receive,call=0;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>++call===1?{transport:'app-server',turnId:'physical',messageId:'start'}:{transport:'app-server',turnId:'physical',messageId:'steer'}};
  const config={dataDir,attachmentRoots:[imageRoot],adapters:[{id:'chat',type:'onebot',allowUsers:['owner'],requireMention:false}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async handler=>{receive=handler;},stop:async()=>{},send:async(target,output)=>{sent.push({target,output});return{id:String(sent.length)};}};
  let bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();await receive({id:'A',chatId:'dm',userId:'owner',kind:'dm',text:'A'});await bridge.submit();
    bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-a',clientMessageId:'start',ordinal:1});
    bridge.expectInput(config.bindings[0],'steer');bridge.event({threadId:'thread',turnId:'physical',type:'input',itemId:'input-b',clientMessageId:'steer',ordinal:20});
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'question',phase:'question',text:'question',ordinal:21});
    bridge.event({threadId:'thread',turnId:'physical',type:'image',itemId:'image',path:image,ordinal:22});
    bridge.event({threadId:'thread',turnId:'physical',type:'text',itemId:'final',phase:'final',text:'answer',ordinal:23});
    bridge.event({threadId:'thread',turnId:'physical',type:'completed'});await bridge.flush();assert.equal(sent.some(({output})=>output.text==='answer'),false);
    await receive({id:'B',chatId:'dm',userId:'owner',kind:'dm',text:'B'});await bridge.submit();await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='question' && output.replyTo==='B'));
    assert.ok(sent.some(({output})=>output.text==='answer' && output.replyTo==='B'));
    assert.ok(sent.some(({output})=>output.files?.[0]?.path===realpathSync(image) && output.replyTo==='B'));
  }finally{await bridge?.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('reaction working lifecycle is per presentation, removes on terminal, and falls back to a quoted marker',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-reaction-working-'));const reactions=[],sent=[];
  const config={dataDir,adapters:[{id:'chat',type:'onebot',allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  let fail=false;
  const adapter={capabilities:{edit:false,reaction:true,typing:false,maxText:2000},start:async()=>{},stop:async()=>{},
    startReaction:async target=>{reactions.push(['start',target]);if(fail)throw new Error('unsupported in this chat');return{id:'reaction-id'};},
    endReaction:async(target,id)=>{reactions.push(['end',target,id]);},
    send:async(target,output)=>{sent.push({target,output});return{id:String(sent.length)};},
  };
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();const binding=config.bindings[0],route=bridge.routeKey(binding);
    bridge.store.setCursor(`reply:${route}`,{messageId:'source-a',userId:'owner'});
    bridge.event({threadId:'thread',turnId:'turn-a',type:'started'});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(reactions[0],['start',{chatId:'dm',kind:'dm',messageId:'source-a',userId:'owner'}]);
    bridge.event({threadId:'thread',turnId:'turn-a',type:'completed'});await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(reactions[1],['end',{chatId:'dm',kind:'dm',messageId:'source-a',userId:'owner'},'reaction-id']);
    fail=true;bridge.store.setCursor(`turn-reply:${route}:turn-b`,{messageId:'source-b',userId:'owner'});
    bridge.event({threadId:'thread',turnId:'turn-b',type:'started'});await new Promise(resolve=>setImmediate(resolve));await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='Working...' && output.replyTo==='source-b'),'unsupported reaction falls back to a durable quoted marker');
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('late terminal for an older physical turn does not clear the current manual turn',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-manual-terminal-'));const config={dataDir,adapters:[{id:'chat',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async()=>{},stop:async()=>{},send:async()=>({id:'sent'})};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();bridge.event({threadId:'thread',turnId:'older',type:'started'});bridge.event({threadId:'thread',turnId:'manual',type:'started'});
    bridge.event({threadId:'thread',turnId:'older',type:'completed'});
    assert.equal(bridge.currentPresentation(config.bindings[0]).turnId,'manual');assert.equal(bridge.active.has('thread'),true);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('start observed before its receipt keeps the submitting chat reply context when newer ingress arrives',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-start-before-receipt-'));const sent=[];let receive,release,calls=0;
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>++calls===1 ? new Promise(resolve=>{release=()=>resolve({transport:'app-server',turnId:'turn-a',messageId:'start-a'});}) : {messageId:'queued'}};
  const config={dataDir,adapters:[{id:'chat',type:'onebot',allowUsers:['a','b']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async handler=>{receive=handler;},stop:async()=>{},send:async(target,output)=>{sent.push({target,output});return{id:String(sent.length)};}};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();await receive({id:'A',chatId:'dm',userId:'a',kind:'dm',text:'A'});await new Promise(resolve=>setImmediate(resolve));
    await receive({id:'B',chatId:'dm',userId:'b',kind:'dm',text:'B'});
    bridge.event({threadId:'thread',turnId:'turn-a',type:'started'});
    bridge.event({threadId:'thread',turnId:'turn-a',type:'text',itemId:'answer',phase:'final',text:'A answer'});await bridge.flush();
    assert.ok(sent.some(({output})=>output.text==='A answer' && output.replyTo==='A'),'A output must retain A context before its receipt');
    release();await new Promise(resolve=>setImmediate(resolve));
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true,force:true});}
});

test('a failed turn before the steer receipt delivers one failure to the accepted input without reviving working', async () => {
  const dataDir=mkdtempSync(join(tmpdir(),'rin-late-failure-')); const sent=[]; let receive, release, calls=0;
  const config={dataDir,adapters:[{id:'chat',type:'onebot',allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false,maxText:2000},start:async handler=>{receive=handler;},stop:async()=>{},send:async(target,output)=>{sent.push({target,output});return{id:String(sent.length)};}};
  const codex={start:async()=>{},stop:async()=>{},watch:async()=>{},queue:async()=>++calls===1?{transport:'app-server',turnId:'physical'}:new Promise(resolve=>{release=()=>resolve({transport:'app-server',turnId:'physical',messageId:'client-b'});})};
  const bridge=new ChatBridge(config,{codex,adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try {
    await bridge.start(); await receive({id:'A',chatId:'dm',userId:'owner',kind:'dm',text:'A'}); await new Promise(setImmediate);
    await receive({id:'B',chatId:'dm',userId:'owner',kind:'dm',text:'B'}); await new Promise(setImmediate);
    bridge.event({threadId:'thread',turnId:'physical',type:'failed'}); await bridge.flush();
    assert.equal(sent.filter(({output})=>output.text?.includes('本轮执行未完成')).length,0);
    release(); await new Promise(setImmediate); await bridge.flush();
    const failures=sent.filter(({output})=>output.text?.includes('本轮执行未完成'));
    assert.equal(failures.length,1); assert.equal(failures[0].output.replyTo,'B');
    assert.equal(bridge.active.has('thread'),false); assert.equal(bridge.workingTimers.size,0);
  } finally { await bridge.stop(); rmSync(dataDir,{recursive:true,force:true}); }
});

test('retiring a presentation removes a reaction whose create request returns late', async () => {
  const dataDir=mkdtempSync(join(tmpdir(),'rin-late-reaction-')); let release; const removed=[];
  const config={dataDir,adapters:[{id:'chat',type:'onebot',allowUsers:['owner']}],bindings:[{adapter:'chat',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,reaction:true},start:async()=>{},stop:async()=>{},send:async()=>({id:'sent'}),startReaction:async()=>new Promise(resolve=>{release=()=>resolve({id:'late'});}),endReaction:async(target,id)=>{removed.push({target,id});}};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try {
    await bridge.start(); const binding=config.bindings[0];
    const first=bridge.activatePresentation(binding,'A','turn',{messageId:'A'});
    const pending=bridge.beginReaction(binding,first);
    bridge.activatePresentation(binding,'B','turn',{messageId:'B'}); release(); await pending;
    assert.deepEqual(removed,[{target:{chatId:'dm',kind:'dm',messageId:'A'},id:'late'}]);
  } finally { await bridge.stop(); rmSync(dataDir,{recursive:true,force:true}); }
});
