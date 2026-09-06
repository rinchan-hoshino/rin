import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RIN_LEGACY_SUBAGENT_INSTRUCTIONS,RIN_SUBAGENT_INSTRUCTIONS} from '../src/install/instructions.mjs';
import {runUpdateMigrations} from '../src/install/migrations.mjs';
import {main} from '../src/cli.mjs';

test('ordinary update runs managed migrations without applying the recommended profile',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-update-migrations-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'AGENTS.md'),`Personal preface.\n\n${RIN_LEGACY_SUBAGENT_INSTRUCTIONS[0]}\n`);
  await writeFile(join(codexHome,'config.toml'),'model_auto_compact_token_limit = 120000\n');
  let request;
  const result=await runUpdateMigrations({codexHome,writeConfig:async value=>{request=value;return{ok:true};}});
  assert.deepEqual(result,{agentsChanged:true,obsoleteConfigRemoved:true});
  assert.equal(await readFile(join(codexHome,'AGENTS.md'),'utf8'),`Personal preface.\n\n${RIN_SUBAGENT_INSTRUCTIONS}\n`);
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
});

test('rin update runs migrations even when the release is already current',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rin-update-current-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'install'),codexHome=join(root,'codex');
  await mkdir(codexHome,{recursive:true});
  await writeFile(join(codexHome,'AGENTS.md'),`${RIN_LEGACY_SUBAGENT_INSTRUCTIONS[0]}\n`);
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
      writeConfig:async value=>{request=value;return{ok:true};},
    }),0);
  } finally { console.log=originalLog; }
  assert.deepEqual(output,['Rin is already up to date.']);
  assert.equal(await readFile(join(codexHome,'AGENTS.md'),'utf8'),`${RIN_SUBAGENT_INSTRUCTIONS}\n`);
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
});
