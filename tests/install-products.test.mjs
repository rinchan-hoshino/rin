import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historySupport,installHistoryTool,installProducts,productSources} from '../src/install/products.mjs';

const temp=async t=>{const dir=await mkdtemp(join(tmpdir(),'rin-install-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('Codex installs into the user prefix without consulting or changing an unwritable POSIX global prefix',async()=>{
  const calls=[];const result=await installProducts({products:['codex'],home:'/safe home',userHome:'/users/test',node:'/node 24/bin/node',npmCli:'/node 24/npm-cli.js',run:async(command,args)=>{calls.push({command,args});return {code:0,stdout:'/fresh/npm'};}});
  assert.deepEqual(calls.map(({command,args})=>({command,args})),[
    {command:'/node 24/bin/node',args:['/node 24/npm-cli.js','install','--global','--prefix','/users/test/.local','@openai/codex']},
  ]);
  assert.equal(result[0].status,'installed');
  assert.equal(result[0].command,'/users/test/.local/bin/codex');
});

test('Windows keeps its configured npm user prefix and refuses a legacy Rin prefix',async()=>{
  const calls=[];
  await assert.rejects(installProducts({products:['codex'],home:'/new/rin',userHome:'/users/test',platform:'win32',node:'/node',npmCli:'/npm-cli.js',run:async(command,args)=>{calls.push({command,args});return {code:0,stdout:'/users/test/.rin/node'};}}),/old ~\/\.rin/);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['/npm-cli.js','prefix','--global']);
});

test('Windows retains npm configured prefix installation behavior',async()=>{
  const calls=[];
  const result=await installProducts({products:['codex'],home:'/new/rin',userHome:'/users/test',platform:'win32',node:'/node',npmCli:'/npm-cli.js',run:async(command,args)=>{calls.push({command,args});return {code:0,stdout:'/users/test/npm'};}});
  assert.deepEqual(calls.map(({command,args})=>({command,args})),[
    {command:'/node',args:['/npm-cli.js','prefix','--global']},
    {command:'/node',args:['/npm-cli.js','install','--global','@openai/codex']},
  ]);
  assert.equal(result[0].command,'/users/test/npm/codex.cmd');
});

test('Windows ChatGPT uses the official Microsoft Store winget identifier',async()=>{
  const calls=[];await installProducts({products:['chatgpt'],home:'C:\\Users\\test',platform:'win32',arch:'x64',run:async(command,args)=>{calls.push({command,args});return {code:0};}});
  assert.deepEqual(calls,[{command:'winget',args:['install','--id','9PLM9XGG6VKS','-s','msstore']}]);
});

test('Linux validates distro before downloading and uses official package argv',async t=>{
  const home=await temp(t),calls=[],downloads=[];
  await installProducts({products:['chatgpt'],home,platform:'linux',arch:'aarch64',osRelease:{ID:'ubuntu',VERSION_ID:'24.04'},download:async(url,path)=>downloads.push({url,path}),run:async(command,args)=>{calls.push({command,args});return {code:0};}});
  assert.equal(downloads[0].url,productSources.chatgpt.deb.arm64);
  assert.equal(calls[0].command,'sudo');assert.deepEqual(calls[0].args.slice(0,3),['apt','install','-y']);
  assert.match(calls[0].args[3],/chatgpt_arm64\.deb$/);
});

test('unsupported Linux rejects before any product mutation',async()=>{
  const calls=[],downloads=[];
  await assert.rejects(installProducts({products:['codex','chatgpt'],home:'/tmp/home',platform:'linux',arch:'x64',osRelease:{ID:'arch',VERSION_ID:'rolling'},download:async(...x)=>downloads.push(x),run:async(...x)=>{calls.push(x);return {code:0};}}),/Unsupported Linux distribution/);
  assert.deepEqual(calls,[]);assert.deepEqual(downloads,[]);
});

test('macOS leaves an existing user application untouched',async()=>{
  const calls=[];const result=await installProducts({products:['chatgpt'],home:'/installation-data',userHome:'/Users/test',platform:'darwin',arch:'arm64',exists:async path=>path==='/Applications/ChatGPT.app',download:async()=>assert.fail('downloaded'),run:async(...x)=>{calls.push(x);return {code:0};}});
  assert.deepEqual(calls,[]);assert.equal(result[0].status,'existing');assert.equal(result[0].path,'/Applications/ChatGPT.app');
});

test('macOS architecture is rejected before an earlier Codex selection mutates',async()=>{
  const calls=[];await assert.rejects(installProducts({products:['codex','chatgpt'],home:'/installation-data',userHome:'/Users/test',platform:'darwin',arch:'x64',run:async(...args)=>{calls.push(args);return {code:0};}}),/Apple Silicon/);
  assert.deepEqual(calls,[]);
});

test('FFF rejects a fake download before registration when its digest is wrong',async t=>{
  const home=await temp(t),codexHome=join(home,'.codex'),calls=[];
  await writeFile(join(home,'payload'),'fixture');
  // The production digest cannot match a fixture, so assert that verification stops before registration.
  await assert.rejects(installHistoryTool({codexCommand:'codex',home,codexHome,platform:'darwin',arch:'arm64',download:async(_url,path)=>writeFile(path,'fixture'),run:async(command,args)=>{calls.push({command,args});return {code:1,stdout:'',stderr:"No MCP server named 'session-history' found"};}}),/checksum mismatch/);
  assert.deepEqual(calls.map(x=>x.args),[['mcp','get','session-history','--json']]);
});

test('FFF selects the pinned GNU Linux asset and passes its release digest to verification',async t=>{
  const home=await temp(t),seen={};
  const result=await installHistoryTool({codexCommand:'codex',home,codexHome:join(home,'.codex'),platform:'linux',arch:'x86_64',libc:'gnu',download:async(url,path)=>{seen.url=url;await writeFile(path,'fixture');},verify:async(_path,digest)=>seen.digest=digest,run:async(_command,args)=>args[1]==='get'?{code:1,stdout:'',stderr:"No MCP server named 'session-history' found"}:{code:0,stdout:''}});
  assert.equal(result.status,'installed');assert.match(seen.url,/fff-mcp-x86_64-unknown-linux-gnu$/);assert.equal(seen.digest,'3b887b272d580f34f9fe6c60cd126be54c4a7cf5f8ffb122d86c81f29b98524e');
});

test('FFF selects the pinned Windows ARM64 executable and requests directory junctions',async t=>{
  const home=await temp(t),seen={links:[]};
  const result=await installHistoryTool({codexCommand:'codex',home,codexHome:join(home,'.codex'),platform:'win32',arch:'arm64',download:async(url,path)=>{seen.url=url;await writeFile(path,'fixture');},verify:async(_path,digest)=>seen.digest=digest,makeLink:async(...args)=>seen.links.push(args),run:async(_command,args)=>args[1]==='get'?{code:1,stdout:'',stderr:"No MCP server named 'session-history' found"}:{code:0,stdout:''}});
  assert.equal(result.status,'installed');assert.match(seen.url,/fff-mcp-aarch64-pc-windows-msvc\.exe$/);assert.equal(seen.digest,'9151f6efc9d5aa9e38aafb7fb2c664700fa950374717305ad41a09a54cfe873e');
  assert.deepEqual(seen.links.map(link=>link[2]),['junction','junction']);
});

test('FFF registers the verified binary with roots and flags as separate argv entries',async t=>{
  const home=await temp(t),codexHome=join(home,'.codex'),calls=[];
  const result=await installHistoryTool({codexCommand:'codex',home,codexHome,platform:'darwin',arch:'arm64',download:async(_url,path)=>writeFile(path,'verified fixture'),verify:async()=>{},run:async(command,args,options)=>{calls.push({command,args,options});return args[1]==='get'?{code:1,stdout:'',stderr:"No MCP server named 'session-history' found"}:{code:0,stdout:''};}});
  assert.equal(result.status,'installed');
  assert.equal(calls.length,2);assert.deepEqual(calls[0].args,['mcp','get','session-history','--json']);
  assert.match(calls[0].options.cwd,/rin-codex-global-/);assert.notEqual(calls[0].options.cwd,home);
  const add=calls[1];assert.deepEqual(add.args.slice(0,4),['mcp','add','session-history','--']);
  assert.match(add.options.cwd,/rin-codex-global-/);assert.notEqual(add.options.cwd,home);
  assert.equal(add.args[4],join(home,'tools','fff-mcp'));
  assert.deepEqual(add.args.slice(5),[join(home,'private','session-history'),'--follow-symlinks','--no-update-check','--no-warmup','--log-file',join(home,'private','logs','fff.log')]);
  assert.equal(calls[0].options.capture,true);assert.equal(calls[0].options.env.CODEX_HOME,codexHome);assert.equal(add.options.env.CODEX_HOME,codexHome);
});

test('FFF preserves a resolved Codex JavaScript argv prefix',async t=>{
  const home=await temp(t),calls=[];
  await installHistoryTool({codexCommand:{command:'/node',args:['/codex.js']},home,codexHome:join(home,'.codex'),platform:'darwin',arch:'arm64',download:async(_url,path)=>writeFile(path,'verified'),verify:async()=>{},run:async(command,args)=>{calls.push({command,args});return args.includes('get')?{code:1,stdout:'',stderr:"No MCP server named 'session-history' found"}:{code:0,stdout:''};}});
  assert.deepEqual(calls[0].args.slice(0,5),['/codex.js','mcp','get','session-history','--json']);
  assert.deepEqual(calls[1].args.slice(0,5),['/codex.js','mcp','add','session-history','--']);
});

test('FFF preserves a different existing MCP entry without overwriting it',async t=>{
  const home=await temp(t),codexHome=join(home,'.codex'),binary=join(home,'tools','fff-mcp'),calls=[];
  await (await import('node:fs/promises')).mkdir(join(home,'tools'),{recursive:true});await writeFile(binary,'already installed');
  const result=await installHistoryTool({codexCommand:'codex',home,codexHome,platform:'darwin',arch:'arm64',exists:async path=>path===binary,verify:async()=>{},run:async(command,args)=>{calls.push({command,args});return {code:0,stdout:JSON.stringify({command:'/different/fff-mcp',args:[]})};}});
  assert.equal(result.status,'conflict');assert.deepEqual(calls.map(x=>x.args.slice(0,3)),[['mcp','get','session-history']]);
});

test('FFF still installs its verified binary when an existing MCP entry is preserved',async t=>{
  const home=await temp(t),calls=[],downloads=[];
  const result=await installHistoryTool({codexCommand:'codex',home,codexHome:join(home,'.codex'),platform:'linux',arch:'x64',libc:'gnu',download:async(url,path)=>{downloads.push(url);await writeFile(path,'verified FFF');},verify:async()=>{},run:async(command,args)=>{calls.push(args);return {code:0,stdout:JSON.stringify({command:'/existing/search',args:[]})};}});
  assert.equal(result.status,'conflict');
  assert.equal(await readFile(result.binary,'utf8'),'verified FFF');
  assert.equal(downloads.length,1);
  assert.deepEqual(calls,[['mcp','get','session-history','--json']]);
});

test('FFF does not mistake an inspection error for an absent MCP server',async t=>{
  const home=await temp(t),calls=[];
  await assert.rejects(installHistoryTool({codexCommand:'codex',home,codexHome:join(home,'.codex'),platform:'darwin',arch:'arm64',run:async(...args)=>{calls.push(args);return {code:2,stdout:'',stderr:'invalid configuration'};}}),/Could not inspect.*invalid configuration/);
  assert.equal(calls.length,1);await assert.rejects(access(join(home,'tools')));
});

test('history support can be checked before cutover',()=>{
  assert.equal(historySupport({platform:'darwin',arch:'arm64'}).supported,true);
  assert.equal(historySupport({platform:'darwin',arch:'x64'}).supported,true);
  assert.equal(historySupport({platform:'linux',arch:'x64',libc:'gnu'}).asset,'fff-mcp-x86_64-unknown-linux-gnu');
  assert.equal(historySupport({platform:'linux',arch:'arm64',libc:'musl'}).asset,'fff-mcp-aarch64-unknown-linux-musl');
  assert.equal(historySupport({platform:'win32',arch:'x64'}).asset,'fff-mcp-x86_64-pc-windows-msvc.exe');
  assert.equal(historySupport({platform:'win32',arch:'arm64'}).asset,'fff-mcp-aarch64-pc-windows-msvc.exe');
  assert.equal(historySupport({platform:'freebsd',arch:'x64'}).supported,false);
});
