import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBridge } from '../src/chat/bridge.mjs';
import { DEFAULT_WORKING_INTERVAL_MS, resolveWorking, workingFrame } from '../src/chat/working.mjs';

test('working configuration selects frames, text and safe fallbacks',()=>{
  assert.deepEqual(resolveWorking({text:'  自定义处理中...  '}).frames,['  自定义处理中...  ']);
  assert.deepEqual(resolveWorking({text:'Ignored',frames:['',42,'  Custom  '],intervalMs:250}).frames,['  Custom  ']);
  assert.deepEqual(resolveWorking({}).frames,['Working...']);
  assert.deepEqual(resolveWorking({text:'',frames:[]}).frames,['Working...']);
  assert.equal(resolveWorking({intervalMs:-1}).intervalMs,DEFAULT_WORKING_INTERVAL_MS);
  assert.equal(workingFrame(resolveWorking({frames:['one','two']}),3),'two');
  assert.equal(workingFrame(), 'Working...');
});

test('editable working frames rotate without discarding summary or commentary and stop on final',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-working-rotation-'));const calls=[];
  const config={dataDir,display:{working:{frames:['One','Two'],intervalMs:100}},adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:true,typing:false,maxText:2000},start:async()=>{},stop:async()=>{},delete:async()=>{},send:async(_target,output)=>{calls.push(output);return{id:output.editId||'progress'};}};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();bridge.event({threadId:'thread',turnId:'turn',type:'started'});await bridge.flush();
    await new Promise(resolve=>setTimeout(resolve,130));await bridge.flush();assert.match(calls.at(-1).text,/Two/);
    bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'summary',phase:'summary',text:'Plan'});
    bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'comment',phase:'commentary',text:'Checked files'});await bridge.flush();
    await new Promise(resolve=>setTimeout(resolve,130));await bridge.flush();
    assert.match(calls.at(-1).text,/^\.\.\. Plan/);assert.match(calls.at(-1).text,/Checked files/);
    bridge.event({threadId:'thread',turnId:'turn',type:'text',itemId:'final',phase:'final',text:'Done'});await bridge.flush();
    const count=calls.length;await new Promise(resolve=>setTimeout(resolve,130));await bridge.flush();assert.equal(calls.length,count);assert.equal(bridge.workingTimers.size,0);
    for(const type of ['completed','failed','observerError']){
      bridge.event({threadId:'thread',turnId:type,type:'started'});
      assert.equal(bridge.workingTimers.size,1);
      bridge.event({threadId:'thread',turnId:type,type});
      assert.equal(bridge.workingTimers.size,0);
    }
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});

test('non-editing transports stage one custom working marker without rotation',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rin-working-marker-'));const calls=[];
  const config={dataDir,display:{working:{text:'处理中...',intervalMs:100}},adapters:[{id:'q',type:'qqbot',allowUsers:['owner']}],bindings:[{adapter:'q',chatId:'dm',kind:'dm',threadId:'thread',mirror:true}]};
  const adapter={capabilities:{edit:false,typing:false},start:async()=>{},stop:async()=>{},send:async(_target,output)=>{calls.push(output);return{id:'marker'};}};
  const bridge=new ChatBridge(config,{codex:{start:async()=>{},stop:async()=>{},watch:async()=>{}},adapterFactory:async()=>adapter,log:{info(){},warn(){},error(){}}});
  try{
    await bridge.start();bridge.event({threadId:'thread',turnId:'turn',type:'started'});await bridge.flush();
    await new Promise(resolve=>setTimeout(resolve,130));await bridge.flush();
    assert.deepEqual(calls.map(call=>call.text),['处理中...']);assert.equal(bridge.workingTimers.size,0);
  }finally{await bridge.stop();rmSync(dataDir,{recursive:true});}
});
