import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Store,Nerve,makeServer} from '../src/nerve.mjs';
import {createHandler} from '../src/nerve-mcp.mjs';

test('Gateway admission through Nerve HTTP becomes a canonical range event and explicit MCP reply',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const nerve=new Nerve({targets:{main:{type:'command',argv:['true']}},attention:{target:'main',ownerUserIds:['owner'],ambientWindowMs:900000}},store);
 let sends=0;nerve.attention.sendImpl=async()=>{sends++;return {id:'reply-id'};};
 const token='test-nerve-token-123456789012345678901234';const server=makeServer(nerve,token);
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const port=server.address().port,url=`http://127.0.0.1:${port}/attention/messages`;
 const record={id:'canonical',messageId:'123',platform:'discord',platformInstance:'bot',chatKey:'discord/bot:channel',userId:'owner',role:'user',text:'hello',receivedAt:new Date().toISOString(),disposition:'record_only'};
 assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(record)})).status,401);
 const put=()=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(record)});
 assert.equal((await (await put()).json()).inserted,true);assert.equal((await (await put()).json()).inserted,false);
 nerve.attention.scan(Date.now()+30000);assert.equal(store.status().length,1);
 const event=store.event(store.status()[0].id);assert.match(event.payload.prompt,/nerve_read_chat/);assert.ok(!event.payload.prompt.includes('hello'));
 const mcp=createHandler({port,token});
 const call=(name,args)=>mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
 const read=await call('nerve_read_chat',{chatKey:record.chatKey,limit:10});assert.equal(read.result.isError,false);assert.match(read.result.content[0].text,/hello/);
 const args={id:'send-once',chatKey:record.chatKey,text:'reply',replyTo:'123'};
 assert.equal((await call('nerve_send_chat',args)).result.isError,false);await call('nerve_send_chat',args);assert.equal(sends,1);
});
