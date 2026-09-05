import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterTypes,allowed} from '../src/chat/policy.mjs';

test('all adapters admit registered group commands by identity while preserving ordinary routing and mention',()=>{
  for(const type of adapterTypes){
    const config={type,allowUsers:['allowed'],dmOnly:true};
    const message={id:'message',chatId:'any-group',userId:'allowed',kind:'group',mentioned:true,text:'/usage'};
    assert.equal(allowed(config,message,{command:true}),true,type);
    assert.equal(allowed(config,message),false,type);
    assert.equal(allowed(config,{...message,userId:'stranger'},{command:true}),false,type);
    assert.equal(allowed(config,{...message,mentioned:false},{command:true}),false,type);
    assert.equal(allowed(config,{...message,chatId:'another-group'},{command:true}),true,type);
  }
});
