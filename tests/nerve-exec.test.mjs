import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Nerve,Store,validateConfig} from '../src/nerve.mjs';

const threadId='12345678-1234-1234-1234-123456789abc';
function fixture(t,fail=false) {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'rin-nerve-exec-')));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const capture=join(dir,'calls.jsonl'),peer=join(dir,'peer.mjs');
 writeFileSync(peer,`import {appendFileSync} from 'node:fs';
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
 appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),input,cwd:process.cwd()})+'\\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(threadId)}}));
 ${fail ? "process.stderr.write('response lost with secret diagnostic');process.exitCode=1;" : `
 console.log(JSON.stringify({type:'turn.started'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'event handled'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{}}));`}
});`);
 const store=new Store(join(dir,'events.sqlite'));
 const config={database:join(dir,'events.sqlite'),cwd:dir,targets:{codex:{type:'codex',threadId,command:[process.execPath,peer]}},triggers:[]};
 const nerve=new Nerve(config,store);t.after(async()=>{await nerve.close();store.close();});
 return {nerve,store,capture,config,dir};
}
test('Nerve resumes the configured existing thread once and records confirmed execution completion',async t=>{
 const {nerve,store,capture,dir}=fixture(t);
 assert.equal(store.enqueue('event-one','codex',{prompt:'literal `code` $(not a shell)'}),true);
 await nerve.tick();
 const event=store.event('event-one');assert.equal(event.state,'done');assert.equal(event.result.completed,true);
 assert.equal(event.result.transport,'codex-exec');assert.equal(event.result.threadId,threadId);
 assert.equal(event.result.text,'event handled');
 assert.equal(store.enqueue('event-one','codex',{prompt:'literal `code` $(not a shell)'}),false);
 await nerve.tick();assert.equal(store.retry('event-one'),0);
 const calls=readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls,[{args:['exec','resume','--json','--skip-git-repo-check',threadId,'-'],input:'External event event-one\n\nliteral `code` $(not a shell)',cwd:dir}]);
});
test('Nerve never automatically replays an ambiguous Codex execution',async t=>{
 const {nerve,store,capture}=fixture(t,true);
 store.enqueue('uncertain','codex',{prompt:'test'});await nerve.tick();await nerve.tick();
 assert.equal(store.event('uncertain').state,'uncertain');assert.equal(store.event('uncertain').attempts,1);
 assert.match(store.event('uncertain').error,/outcome uncertain/);
 assert.equal(store.event('uncertain').error.includes('secret diagnostic'),false);
 assert.equal(readFileSync(capture,'utf8').trim().split('\n').length,1);
});
test('Nerve permits execution cwd while rejecting obsolete app-server state and idempotent retry claims',()=>{
 const base={targets:{codex:{type:'codex',threadId}},triggers:[]};
 assert.doesNotThrow(()=>validateConfig(base));
 assert.doesNotThrow(()=>validateConfig({...base,targets:{codex:{...base.targets.codex,cwd:'/tmp'}}}));
 for(const overrides of [{stateFile:'old.json'},{threadId:undefined,stateFile:'old.json'},{idempotent:true},{command:[]}])
  assert.throws(()=>validateConfig({...base,targets:{codex:{...base.targets.codex,...overrides}}}));
});
