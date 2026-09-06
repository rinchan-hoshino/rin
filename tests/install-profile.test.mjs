import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { applyRecommendedCodexProfile, removeObsoleteCodexSettings, RIN_OBSOLETE_CODEX_EDITS, RIN_RECOMMENDED_CODEX_EDITS } from '../src/install/profile.mjs';

test('recommended profile batch-upserts only the reviewed keys',async()=>{
  let request;
  await applyRecommendedCodexProfile({codexHome:'/tmp/codex-home',writeConfig:async value=>{request=value;return{ok:true};}});
  assert.equal(request.filePath,undefined,'Codex selects the user config from CODEX_HOME');
  assert.equal(request.reloadUserConfig,true);
  assert.deepEqual(request.edits,RIN_RECOMMENDED_CODEX_EDITS.map(edit=>({...edit})));
  assert.deepEqual(request.edits.map(edit=>edit.keyPath),[
    'features.context_management.experimental_mode','features.memories','tool_output_token_limit','model','model_reasoning_effort','sandbox_mode','approval_policy',
    'desktop.preventSleepWhileRunning','desktop.keepRemoteControlAwakeWhilePluggedIn',
    'desktop.git-branch-prefix','desktop.git-pull-request-merge-method','desktop.worktree-upstream-refresh-mode',
    'apps.connector_20205bf7d4e99a89d7154bb849718324.enabled',
    'apps.connector_openai_hotline.enabled','apps.connector_openai_safety_settings.enabled',
  ]);
  assert.ok(request.edits.every(edit=>edit.mergeStrategy==='upsert'));
  assert.equal(request.edits.find(edit=>edit.keyPath==='approval_policy').value,'never');
  assert.equal(request.edits.find(edit=>edit.keyPath==='tool_output_token_limit').value,4000);
  assert.equal(request.edits.some(edit=>edit.keyPath==='model_auto_compact_token_limit'),false);
  assert.equal(request.edits.find(edit=>edit.keyPath==='model').value,'gpt-6-astra');
  assert.equal(request.edits.find(edit=>edit.keyPath==='model_reasoning_effort').value,'medium');
  assert.ok(!request.edits.some(edit=>/service_tier|chronicle/i.test(edit.keyPath)));
});

test('update migration removes only the obsolete compaction key',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-migration-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'model_auto_compact_token_limit = 120000\n');
  let request;
  await removeObsoleteCodexSettings({codexHome,writeConfig:async value=>{request=value;return{ok:true};}});
  assert.deepEqual(request,{edits:RIN_OBSOLETE_CODEX_EDITS.map(edit=>({...edit})),reloadUserConfig:true});
  assert.deepEqual(request.edits,[{keyPath:'model_auto_compact_token_limit',value:null,mergeStrategy:'upsert'}]);
});

test('update migration leaves an absent config and an unrelated config untouched',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-noop-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  let writes=0,resolves=0;
  const options={codexHome,writeConfig:async()=>{writes++;},resolveCommand:async()=>{resolves++;}};
  assert.deepEqual(await removeObsoleteCodexSettings(options),{status:'unchanged'});
  await writeFile(join(codexHome,'config.toml'),'model = "gpt-6-astra"\n');
  assert.deepEqual(await removeObsoleteCodexSettings(options),{status:'unchanged'});
  assert.equal(writes,0);assert.equal(resolves,0);
});

test('a same-named key inside a TOML table is not treated as the managed root key',async t=>{
  const codexHome=await mkdtemp(join(tmpdir(),'rin-profile-scoped-'));
  t.after(()=>rm(codexHome,{recursive:true,force:true}));
  await writeFile(join(codexHome,'config.toml'),'[profiles.work]\nmodel_auto_compact_token_limit = 90000\n');
  let writes=0;
  assert.deepEqual(await removeObsoleteCodexSettings({codexHome,writeConfig:async()=>{writes++;}}),{status:'unchanged'});
  assert.equal(writes,0);
});

test('declining recommendations remains a pure choice with an explicit preservation message',async()=>{
  const {collectChoices}=await import('../src/install/setup.mjs'); const output=[];
  const answers=[[],false,'skip',false,true];
  const ui={intro(){},note(){},outro(){},cancel(){},isCancel(){return false},multiselect:async()=>answers.shift(),confirm:async()=>answers.shift(),select:async()=>answers.shift(),text:async()=>answers.shift(),log:{info:line=>output.push(line),error(){}}};
  const choices=await collectChoices({ui});
  assert.equal(choices.recommendations,false);assert.match(output.join('\n'),/Existing Codex settings will be preserved/);
});
