import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../dist/cli.js';
import {readConfig} from '../dist/rin.js';
import {agentCommand} from '../dist/agents/command.js';
async function setup(t,agent,legacy=false) {
 const home=await mkdtemp(join(tmpdir(),'rin-cli-agent-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(join(home,'private'));
 await writeFile(join(home,'private/daemon.json'),JSON.stringify({chat:'chat.json'}));
 await writeFile(join(home,'private/chat.json'),JSON.stringify({[legacy?'codex':'agent']:agent,adapters:[],bindings:[]}));return home;
}
for(const type of ['codex','claude-code','pi','opencode'])test(`rin launches the configured ${type} with literal arguments and exit status`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'rin-cli-exec-'));t.after(()=>rm(root,{recursive:true,force:true}));const script=join(root,'run.mjs'),output=join(root,'out.json');
 await writeFile(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),home:process.env.CODEX_HOME,marker:process.env.RIN_TEST_MARKER}));process.exit(23);`);
 const agent=type==='codex'?{type,command:[process.execPath,script],codexHome:root}:{type,command:process.execPath,extraArgs:[script],cwd:root,env:{RIN_TEST_MARKER:'configured'}};
 const home=await setup(t,agent);const args=['start','a b','$(literal)','--','--help'];assert.equal(await main(['--',...args],{home}),23);
 const got=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(got.args,args);
 if(type==='codex')assert.equal(got.home,root);else {assert.equal(got.cwd,await realpath(root));assert.equal(got.marker,'configured');}
 assert.equal(await main([],{home}),23);assert.deepEqual(JSON.parse(await readFile(output,'utf8')).args,[]);
 await assert.rejects(main(['start','unexpected'],{home}),/Usage/);
});
test('legacy Codex settings normalize once for both bridge and CLI',async t=>{
 const home=await setup(t,{command:['chosen-codex','--profile','personal'],codexHome:'/tmp/chosen-home'},true);
 const config=readConfig(join(home,'private/chat.json'));
 assert.equal(config.agent.type,'codex');assert.deepEqual(agentCommand(config.agent).args,['--profile','personal']);assert.equal(agentCommand(config.agent).command,'chosen-codex');
});
test('agent launch requires configured chat and reports missing executable',async t=>{
 const home=await setup(t,{type:'pi',command:'/no-such-executable/rin'});await assert.rejects(main([],{home}),{code:'ENOENT'});
 await writeFile(join(home,'private/daemon.json'),'{}');await assert.rejects(main([],{home}),/Configure a chat agent/);
});
