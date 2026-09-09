import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CliAgentBridge} from '../dist/agents/cli.js';
import {createAgentBridge} from '../dist/agents/factory.js';

async function executable(t){
  const dir=await mkdtemp(join(tmpdir(),'rin-agent-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'agent-fixture.mjs'),log=join(dir,'calls.jsonl');
  await writeFile(path,"#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(process.env.CALLS,JSON.stringify(process.argv.slice(2))+'\\n');console.log('real child output');\n");
  await chmod(path,0o755);return{path,log};
}

for(const [type,expected] of [
  ['claude-code',['-p','--resume','session-id','--output-format','text','hello']],
  ['pi',['-p','--session','session-id','hello']],
  ['opencode',['run','--session','session-id','hello']],
])test(type+' uses its native non-interactive resume argv and emits normalized final output',async t=>{
  if(process.platform==='win32')return t.skip('fixture executable uses a POSIX shebang');
  const fixture=await executable(t),events=[];
  const bridge=new CliAgentBridge({type,command:fixture.path,env:{CALLS:fixture.log}});bridge.onEvent=event=>events.push(event);
  await bridge.start();const receipt=await bridge.queue('session-id',{text:'hello',files:[]});
  assert.equal(receipt.transport,type+'-cli');assert.ok(receipt.turnId);
  while(!events.some(event=>event.type==='completed'))await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(JSON.parse((await readFile(fixture.log,'utf8')).trim()),expected);
  assert.deepEqual(events.map(event=>event.type),['started','text','completed']);
  assert.equal(events[1].phase,'final');assert.equal(events[1].text,'real child output');
  await bridge.stop();
});

test('CLI turns for one native session are serialized',async t=>{
  if(process.platform==='win32')return t.skip('fixture executable uses a POSIX shebang');
  const dir=await mkdtemp(join(tmpdir(),'rin-agent-serial-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'agent.mjs'),log=join(dir,'log');
  await writeFile(path,"#!/usr/bin/env node\nimport{appendFileSync}from'node:fs';appendFileSync(process.env.CALLS,'start '+process.argv.at(-1)+'\\n');await new Promise(r=>setTimeout(r,30));appendFileSync(process.env.CALLS,'end '+process.argv.at(-1)+'\\n');console.log(process.argv.at(-1));\n");await chmod(path,0o755);
  const bridge=new CliAgentBridge({type:'pi',command:path,env:{CALLS:log}});await bridge.start();
  const first=bridge.queue('same',{text:'one',files:[]}),second=bridge.queue('same',{text:'two',files:[]});await Promise.all([first,second]);
  await Promise.all([...bridge.tails.values()]);
  await bridge.stop();assert.deepEqual((await readFile(log,'utf8')).trim().split('\n'),['start one','end one','start two','end two']);
});

test('factory exposes Codex, Claude Code, pi and OpenCode without starting a server',()=>{
  for(const type of ['codex','claude-code','pi','opencode'])assert.equal(typeof createAgentBridge({type}).queue,'function');
  assert.throws(()=>createAgentBridge({type:'unknown'}),/Unsupported agent/);
});
