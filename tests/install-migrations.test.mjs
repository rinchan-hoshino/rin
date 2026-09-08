import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const retired = JSON.parse(await readFile(new URL('./fixtures/install/retired-subagent-guidance.json', import.meta.url), 'utf8')).map(x=>x.text);
import {runUpdateMigrations,migrationHome} from '../dist/install/migrations.js';
import {pathToFileURL} from 'node:url';
import {main} from '../dist/cli.js';

test('ordinary update removes all historical managed guidance generations without applying the recommended profile',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-update-migrations-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'AGENTS.md'),`Personal preface.\n\n${retired.join('\n')}\n`);
  await writeFile(join(codexHome,'config.toml'),'model_auto_compact_token_limit = 120000\n');
  let request;
  const result=await runUpdateMigrations({home:null,codexHome,writeConfig:async value=>{request=value;return{ok:true};}});
  assert.deepEqual(result,{agentsChanged:true,obsoleteConfigRemoved:true,contextManagementMigrated:false});
  assert.equal(await readFile(join(codexHome,'AGENTS.md'),'utf8'),'Personal preface.\n\n' + '\n'.repeat(retired.length));
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
});

test('rin update removes every historical guidance generation when the release is already current',async t=>{
  for (const legacy of retired) {
  const root=await mkdtemp(join(tmpdir(),'rin-update-current-'));
  // Git may finish detached maintenance after update returns. Retry transient
  // ENOTEMPTY during fixture removal without weakening the migration checks.
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const home=join(root,'install'),codexHome=join(root,'codex');
  await mkdir(codexHome,{recursive:true});
  await writeFile(join(codexHome,'AGENTS.md'),`${legacy}\n`);
  await writeFile(join(codexHome,'config.toml'),'model_auto_compact_token_limit = 120000\n');
  const repository=process.cwd();
  const current=execFileSync('git',['rev-parse','main'],{cwd:repository,encoding:'utf8'}).trim();
  await mkdir(home,{recursive:true});
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',repository,current,node:process.execPath}));
  let request;
  const originalLog=console.log;
  const output=[];
  console.log=value=>output.push(value);
  try {
    assert.equal(await main(['update'],{
      home,codexHome,
      serviceFactory:()=>({}),
      ensureMcp:async()=>({registered:true,needsActivation:false}),
      writeConfig:async value=>{request=value;return{ok:true};},
    }),0);
  } finally { console.log=originalLog; }
  assert.deepEqual(output,['Rin is already up to date.']);
  assert.equal(await readFile(join(codexHome,'AGENTS.md'),'utf8'),'\n');
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
  }
});

test('candidate migration discovers custom install homes for older updaters',()=>{
  const home=join(tmpdir(),'custom Rin');
  assert.equal(migrationHome(pathToFileURL(join(home,'releases','a'.repeat(40),'src/install/migrations.mjs'))),home);
  assert.equal(migrationHome(pathToFileURL(join(home,'src/install/migrations.mjs'))),undefined);
});

test('migration loaded by an older updater repairs its custom home without receiving home',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rin-old-updater-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'custom install'),codexHome=join(root,'codex'),release=join(home,'releases','b'.repeat(40));
  await mkdir(codexHome);await mkdir(release,{recursive:true});
  await cp(join(process.cwd(),'src'),join(release,'src'),{recursive:true});
  await cp(join(process.cwd(),'dist'),join(release,'dist'),{recursive:true});
  await symlink(join(process.cwd(),'node_modules'),join(release,'node_modules'),process.platform==='win32'?'junction':'dir');
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',repository:'/origin',current:'a'.repeat(40),node:process.execPath}));
  const {runUpdateMigrations:migrate}=await import(pathToFileURL(join(release,'src/install/migrations.mjs')));
  const canonicalHome=await realpath(home);
  const events=[],service={};
  await migrate({codexHome,service,
    ensureMcp:async options=>{assert.equal(options.home,canonicalHome);events.push('repair');return{needsActivation:true};},
    activateMcp:async options=>{assert.equal(options.home,canonicalHome);assert.equal(options.service,service);events.push('activate');},
  });
  assert.deepEqual(events,['repair','activate']);
});

test('update repairs bundled MCP and activates added work even without a newer release',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rin-update-mcp-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'install'),codexHome=join(root,'codex');
  await mkdir(home,{recursive:true});await mkdir(codexHome);
  const current='a'.repeat(40);
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',repository:'/origin',current,node:process.execPath,codexHome}));
  const events=[],service={};
  await main(['update'],{home,codexHome,serviceFactory:()=>service,prepare:async()=>({sha:current,changed:false}),
    ensureMcp:async options=>{assert.equal(options.codexHome,codexHome);events.push('repair');return{needsActivation:true,configPath:'/config'};},
    activateMcp:async options=>{assert.equal(options.service,service);assert.equal(options.nerve.needsActivation,true);events.push('activate');},
  });
  assert.deepEqual(events,['repair','activate']);
  assert.match(await readFile(join(home,'nerve-mcp-run.mjs'),'utf8'),/nerve-mcp\.mjs/);
});

test('candidate MCP activation is deferred until the verified release is selected',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rin-update-mcp-switch-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'install'),release=join(root,'candidate'),current='a'.repeat(40),next='b'.repeat(40);
  await mkdir(join(release,'src/install'),{recursive:true});await mkdir(home);
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',repository:'/origin',current,node:process.execPath}));
  await writeFile(join(release,'src/install/migrations.mjs'),`export async function runUpdateMigrations(options){if(!options.deferActivation)throw Error('activation not deferred');return{nerve:await options.ensureMcp(options)};}`);
  const events=[];
  await main(['update'],{home,serviceFactory:()=>({}),prepare:async()=>({sha:next,release,changed:true}),
    ensureMcp:async()=>{events.push('repair');return{needsActivation:true};},
    switchTo:async()=>events.push('switch'),
    activateMcp:async({nerve})=>{assert.equal(nerve.needsActivation,true);events.push('activate');},
  });
  assert.deepEqual(events,['repair','switch','activate']);
});

test('rin update runs the verified candidate migration before switching releases',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rin-update-candidate-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'install'),release=join(root,'candidate'),current='a'.repeat(40),next='b'.repeat(40);
  await mkdir(join(release,'src/install'),{recursive:true});
  await mkdir(home,{recursive:true});
  await writeFile(join(home,'install.json'),JSON.stringify({schema:1,type:'git',repository:'/origin',current,node:process.execPath}));
  await writeFile(join(release,'src/install/migrations.mjs'),`export async function runUpdateMigrations(options){await options.writeConfig({source:'candidate'});}`);
  const events=[];
  assert.equal(await main(['update'],{
    home,
    serviceFactory:()=>({}),
    prepare:async()=>({sha:next,release,changed:true}),
    writeConfig:async request=>events.push(['migrate',request]),
    switchTo:async(_home,candidate)=>events.push(['switch',candidate.sha]),
  }),0);
  assert.deepEqual(events,[['migrate',{source:'candidate'}],['switch',next]]);
});


test('update migrates the legacy context flag without applying other recommendations', async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-update-context-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  const file=join(codexHome,'config.toml');
  await writeFile(file,'[features]\ncontext_management = false\n');
  const filePath=await realpath(file);
  const requests=[];
  const result=await runUpdateMigrations({home:null,codexHome,
    readConfig:async()=>({layers:[{name:{type:'user',file:filePath},version:'v1',config:{features:{context_management:false}}}]}),
    writeConfig:async request=>{requests.push(request);return{status:'ok'};},
  });
  assert.equal(result.contextManagementMigrated,true);
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0].edits,[{keyPath:'features.context_management',value:{experimental_mode:false},mergeStrategy:'replace'}]);
});
