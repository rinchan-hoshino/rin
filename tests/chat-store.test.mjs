import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../src/chat/store.mjs';
import { allowed, splitText, validateConfig } from '../src/chat/policy.mjs';

test('inbound replay is deduped and ambiguous submission stays uncertain across restart', () => {
  const dir = mkdtempSync(join(tmpdir(),'rin-store-')); const path = join(dir,'chat.sqlite');
  let s = new ChatStore(path);
  const event = {id:'1',chatId:'c',userId:'u',text:'hello'};
  const a = s.admit('discord','thread',event); assert.equal(a.fresh,true);
  assert.equal(s.admit('discord','thread',event).fresh,false);
  s.inboxState(a.id,'submitting'); s.close(); s = new ChatStore(path);
  assert.deepEqual(s.status().inbox.map(x => [x.state,x.count]),[['uncertain',1]]);
  assert.equal(s.pending().length,0); s.close(); rmSync(dir,{recursive:true});
});
test('outbox preserves newer edits arriving during a send, never replays uncertain sends', () => {
  const dir = mkdtempSync(join(tmpdir(),'rin-outbox-')); const path = join(dir,'chat.sqlite');
  let s = new ChatStore(path); s.stage('item','route',{text:'a'}); const old = s.delivery('item');
  s.sending('item'); s.stage('item','route',{text:'ab'}); s.sent('item',old.payload,'remote-1');
  assert.equal(s.delivery('item').state,'pending'); assert.equal(s.delivery('item').message_id,'remote-1');
  s.sending('item'); s.close(); s = new ChatStore(path);
  s.stage('item','route',{text:'abc'}); assert.equal(s.delivery('item').state,'pending');
  assert.equal(s.outgoing().length,1);
  s.stage('new','route',{text:'first send'});s.sending('new');s.close();s=new ChatStore(path);
  assert.equal(s.delivery('new').state,'uncertain');s.close(); rmSync(dir,{recursive:true});
});
test('DM-only rejects owner guild mentions and no wildcard is treated as authorization', () => {
  const a = {type:'discord',allowUsers:['owner']};
  const m = {id:'1',chatId:'2',userId:'owner',kind:'group',mentioned:true,text:'hi'};
  assert.equal(allowed(a,m),false); assert.equal(allowed(a,{...m,kind:'dm'}),true);
  assert.equal(allowed({...a,allowUsers:['*']},{...m,kind:'dm'}),false);
  assert.throws(() => validateConfig({adapters:[{id:'d',type:'discord',allowUsers:['owner']}],bindings:[{adapter:'d',chatId:'2',threadId:'t',kind:'group'}]}),/DM-only/);
});
test('a Codex thread binds one chat only and every binding explicitly mirrors', () => {
  const adapters=[{id:'d',type:'discord',allowUsers:['owner']},{id:'t',type:'telegram',allowUsers:['owner']}];
  const first={adapter:'d',chatId:'one',threadId:'thread',kind:'dm',mirror:true};
  assert.throws(()=>validateConfig({adapters,bindings:[first,{adapter:'t',chatId:'two',threadId:'thread',kind:'dm',mirror:true}]}),/only one chat/);
  assert.throws(()=>validateConfig({adapters,bindings:[{...first,mirror:false}]}),/mirror:true/);
  assert.throws(()=>validateConfig({adapters,bindings:[{...first,mirror:undefined}]}),/mirror:true/);
  assert.equal(validateConfig({adapters,bindings:[first]}).bindings.length,1);
});
test('retiring a sent surplus chunk stages deletion while unsent surplus is discarded', () => {
  const dir=mkdtempSync(join(tmpdir(),'rin-retire-'));const path=join(dir,'chat.sqlite');const s=new ChatStore(path);
  try{
    s.stage('sent','route',{text:'old'},'group');s.sending('sent');s.sent('sent',JSON.stringify({text:'old'}),'remote');
    s.stage('unsent','route',{text:'queued'},'group');
    s.retire('group',[]);
    assert.deepEqual(JSON.parse(s.delivery('sent').payload),{delete:true});assert.equal(s.delivery('sent').state,'pending');
    assert.equal(s.delivery('unsent').state,'deleted');
  }finally{s.close();rmSync(dir,{recursive:true});}
});
test('text splitting preserves all content and does not split emoji surrogate pairs', () => {
  const text='x'.repeat(9)+'😀'+'\nhello'; const parts=splitText(text,10);
  assert.equal(parts.join(''),text); assert.ok(parts.every(p=>p.length<=10));
  assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
});
