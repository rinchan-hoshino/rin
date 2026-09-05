import test from 'node:test';
import assert from 'node:assert/strict';
import {QQ_COMMAND_PANEL_REMARK, qqCommandPanels, syncQQCommandPanels} from '../src/chat/qq-commands.mjs';

const commands=[
  {name:'help',description:'Show available commands'},
  {name:'usage',description:'Show account usage in a private chat',privateOnly:true},
];

function fixture(recordsByScope) {
  const calls=[];
  const bot={
    tokenManager:{getAccessToken:async(appId,secret)=>{calls.push(['token',appId,secret]);return'access';}},
    apiClient:{request:async(token,method,path,body)=>{
      calls.push([method,path,body,token]);
      if(method==='GET')return{records:recordsByScope[/scope=([^&]+)/.exec(path)?.[1]] || [],next_cursor:'',is_end:true};
      return{};
    }},
  };
  return{bot,calls};
}

test('QQ command panels expose the current registry and filter private commands in groups',()=>{
  const [c2c,group]=qqCommandPanels(commands);
  assert.equal(c2c.panel.remark,QQ_COMMAND_PANEL_REMARK);
  assert.deepEqual(c2c.panel.items.map(item=>item.name),['/help','/usage']);
  assert.deepEqual(group.panel.items.map(item=>item.name),['/help']);
});

test('QQ dynamic panels expose all commands in C2C and omit private commands from groups',()=>{
  const commands=[
    {name:'ping',description:'Check latency',run(){throw new Error('must not run');}},
    {name:'private_note',description:'Store a private note',argument:'Text',privateOnly:true,run(){throw new Error('must not run');}},
  ];
  const [c2c,group]=qqCommandPanels(commands);
  assert.deepEqual(c2c.panel.items.map(item=>item.name),['/ping','/private_note']);
  assert.deepEqual(group.panel.items.map(item=>item.name),['/ping']);
  assert.equal(JSON.stringify([c2c,group]).includes('run'),false);
  assert.equal(JSON.stringify([c2c,group]).includes('argument'),false);
});

test('QQ panel sync deletes legacy app panels and creates the authoritative scoped panels',async()=>{
  const foreign={panel_id:'foreign',target_type:'all',panel:{remark:'Old commands',items:[{type:'command',name:'/jrrp'}]}};
  const mixed={panel_id:'mixed',target_type:'all',panel:{remark:'Mixed',items:[{type:'command',name:'/r'},{type:'link',name:'Docs'}]}};
  const {bot,calls}=fixture({c2c:[foreign,mixed],group:[],channel:[{...foreign,panel_id:'channel-old'}]});
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'},commands);
  assert.deepEqual(calls[0],['token','app','secret']);
  const writes=calls.filter(call=>call[0]!=='GET'&&call[0]!=='token');
  assert.deepEqual(writes.map(call=>[call[0],call[1]]),[
    ['DELETE','/v2/panels/foreign'],['PUT','/v2/panels/mixed'],['POST','/v2/panels'],['POST','/v2/panels'],['DELETE','/v2/panels/channel-old'],
  ]);
  assert.deepEqual(writes[1][2].panel.items,[{type:'link',name:'Docs'}]);
});

test('QQ panel sync no-ops exact panels and updates only the unique owned panel',async()=>{
  const [c2c,group]=qqCommandPanels(commands);
  const {bot,calls}=fixture({
    c2c:[{panel_id:'c',target_type:'all',panel:c2c.panel}],
    group:[{panel_id:'g/id',target_type:'all',panel:{remark:QQ_COMMAND_PANEL_REMARK,items:[]}}],
  });
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'},commands);
  const writes=calls.filter(call=>call[0]!=='GET'&&call[0]!=='token');
  assert.deepEqual(writes,[[
    'PUT','/v2/panels/g%2Fid',{panel:group.panel},'access',
  ]]);
});

test('QQ panel sync retains one stable Rin panel and deletes duplicate panels',async()=>{
  const owned={panel_id:'a',target_type:'all',panel:{remark:QQ_COMMAND_PANEL_REMARK,items:[]}};
  const {bot,calls}=fixture({c2c:[owned,{...owned,panel_id:'b'}]});
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'},commands);
  assert.deepEqual(calls.filter(call=>call[0]==='DELETE').map(call=>call[1]),['/v2/panels/b']);
  assert.equal(calls.some(call=>call[0]==='PUT'&&call[1]==='/v2/panels/a'),true);
});

test('QQ panel cleanup reports SDK codes and continues all independent scopes before failing',async()=>{
  const calls=[];
  const bot={tokenManager:{getAccessToken:async()=> 'token'},apiClient:{request:async(_token,method,path,body)=>{
    calls.push([method,path,body]);
    if(method==='GET')return{records:path.includes('scope=c2c')?[{panel_id:'system',panel:{remark:'Legacy',items:[{type:'command',name:'/jrrp'}]}}]:[],is_end:true};
    if(method==='DELETE'){const error=new Error('secret platform response');error.bizCode=11253;error.httpStatus=403;throw error;}
    return{};
  }}};
  await assert.rejects(syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'},commands),
    /^Error: qq_command_panel_sync_failed:c2c:delete:11253$/);
  assert.deepEqual(calls.filter(call=>call[0]==='GET').map(call=>/scope=([^&]+)/.exec(call[1])[1]),['c2c','group','channel','dm']);
  assert.deepEqual(calls.filter(call=>call[0]==='POST').map(call=>call[2].scope),['c2c','group']);
});

test('QQ readback normalization does not rewrite an unchanged panel',async()=>{
  const writes=[];const desired=qqCommandPanels(commands);
  const bot={tokenManager:{getAccessToken:async()=> 'token'},apiClient:{request:async(_token,method,url,body)=>{
    if(method!=='GET'){writes.push({method,url,body});return {};}
    const match=desired.find(panel=>url.includes(`scope=${panel.scope}`));
    if(!match)return {is_end:true,records:[]};
    return {is_end:true,records:[{...match,panel_id:'owned',panel:{remark:match.panel.remark,items:match.panel.items.map(item=>({name:item.name.replace(/^\//,''),desc:item.desc,type:item.type}))}}]};
  }}};
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'},commands);assert.equal(writes.length,0);
});

test('QQ empty scope response may omit records',async()=>{
  const calls=[];
  const bot={tokenManager:{getAccessToken:async()=> 'token'},apiClient:{request:async(_token,method,path,body)=>{
    calls.push({method,path,body});return method==='GET'?{is_end:true}:{};
  }}};
  await syncQQCommandPanels(bot,{appId:'app',appSecret:'secret'});
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>c.body.scope),['c2c','group']);
});
