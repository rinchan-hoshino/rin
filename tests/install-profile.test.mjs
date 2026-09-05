import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecommendedCodexProfile, RIN_RECOMMENDED_CODEX_EDITS } from '../src/install/profile.mjs';

test('recommended profile batch-upserts only the reviewed keys',async()=>{
  let request;
  await applyRecommendedCodexProfile({codexHome:'/tmp/codex-home',writeConfig:async value=>{request=value;return{ok:true};}});
  assert.equal(request.filePath,undefined,'Codex selects the user config from CODEX_HOME');
  assert.equal(request.reloadUserConfig,true);
  assert.deepEqual(request.edits,RIN_RECOMMENDED_CODEX_EDITS.map(edit=>({...edit})));
  assert.deepEqual(request.edits.map(edit=>edit.keyPath),[
    'features.context_management.experimental_mode','features.memories','sandbox_mode','approval_policy',
    'desktop.preventSleepWhileRunning','desktop.keepRemoteControlAwakeWhilePluggedIn',
    'desktop.git-branch-prefix','desktop.git-pull-request-merge-method','desktop.worktree-upstream-refresh-mode',
    'apps.connector_20205bf7d4e99a89d7154bb849718324.enabled',
    'apps.connector_openai_hotline.enabled','apps.connector_openai_safety_settings.enabled',
  ]);
  assert.ok(request.edits.every(edit=>edit.mergeStrategy==='upsert'));
  assert.equal(request.edits.find(edit=>edit.keyPath==='approval_policy').value,'never');
  assert.ok(!request.edits.some(edit=>/service_tier|chronicle/i.test(edit.keyPath)));
});

test('declining recommendations remains a pure choice with an explicit preservation message',async()=>{
  const {collectChoices}=await import('../src/install/setup.mjs'); const output=[];
  const answers=[[],false,'skip',false,false,true];
  const ui={intro(){},note(){},outro(){},cancel(){},isCancel(){return false},multiselect:async()=>answers.shift(),confirm:async()=>answers.shift(),select:async()=>answers.shift(),text:async()=>answers.shift(),log:{info:line=>output.push(line),error(){}}};
  const choices=await collectChoices({ui});
  assert.equal(choices.recommendations,false);assert.match(output.join('\n'),/Existing Codex settings will be preserved/);
});
