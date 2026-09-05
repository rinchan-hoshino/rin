import test from 'node:test';
import assert from 'node:assert/strict';
import {QQ_COMMAND_PANEL_REMARK, qqCommandPanels, syncQQCommandPanels} from '../src/chat/qq-commands.mjs';

function fixture(recordsByScope) {
  const calls=[];
  const bot={
    tokenManager:{getAccessToken:async(appId,secret)=>{calls.push(['token',appId,secret]);return'access';}},
    apiClient:{request:async(token,method,path,body)=>{
      calls.push([method,path,body,token]);
      if(method==='GET')return{records:recordsByScope[path.includes('scope=c2c')?'c2c':'group'] || [],next_cursor:'',is_end:true};
      return{};
    }},
  };
  return{bot,calls};
}

test('QQ command panels expose five private commands and only help/status in groups',()=>{
  const [c2c,group]=qqCommandPanels();
  assert.equal(c2c.panel.remark,QQ_COMMAND_PANEL_REMARK);
  assert.deepEqual(c2c.panel.items.map(item=>item.name),['/help','/usage','/bind','/status','/unbind']);
  assert.deepEqual(group.panel.items.map(item=>item.name),['/help','/status']);
});

test('QQ panel sync creates only missing Rin-owned scoped panels',async()=>{
  const foreign={panel_id:'foreign',target_type:'all',panel:{remark:'Other feature',items:[]}};
  const {bot,calls}=fixture({c2c:[foreign],group:[]});
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'});
  assert.deepEqual(calls[0],['token','app','secret']);
  const writes=calls.filter(call=>call[0]!=='GET'&&call[0]!=='token');
  assert.equal(writes.length,2); assert.ok(writes.every(call=>call[0]==='POST'&&call[1]==='/v2/panels'));
  assert.deepEqual(writes.map(call=>call[2].scope),['c2c','group']);
});

test('QQ panel sync no-ops exact panels and updates only the unique owned panel',async()=>{
  const [c2c,group]=qqCommandPanels();
  const {bot,calls}=fixture({
    c2c:[{panel_id:'c',target_type:'all',panel:c2c.panel}],
    group:[{panel_id:'g/id',target_type:'all',panel:{remark:QQ_COMMAND_PANEL_REMARK,items:[]}}],
  });
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'});
  const writes=calls.filter(call=>call[0]!=='GET'&&call[0]!=='token');
  assert.deepEqual(writes,[[
    'PUT','/v2/panels/g%2Fid',{panel:group.panel},'access',
  ]]);
});

test('QQ panel sync refuses ambiguous ownership without modifying panels',async()=>{
  const owned={panel_id:'a',target_type:'all',panel:{remark:QQ_COMMAND_PANEL_REMARK,items:[]}};
  const {bot,calls}=fixture({c2c:[owned,{...owned,panel_id:'b'}]});
  await assert.rejects(syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'}),/ambiguous:c2c/);
  assert.equal(calls.filter(call=>['POST','PUT','DELETE'].includes(call[0])).length,0);
});
