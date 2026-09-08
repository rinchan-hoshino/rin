import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureNerveMcp} from '../dist/install/nerve.js';

async function fixture(t) {
  const home=await mkdtemp(join(tmpdir(),'rin-install-nerve-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const codexHome=join(home,'codex'),privateDir=join(home,'private');
  await mkdir(privateDir);
  let current,writes=0;
  const options={home,codexHome,node:'/node',command:{command:'/codex',args:[]},
    run:async(_command,args,opts)=>{
      assert.deepEqual(args,['mcp','get','nerve','--json']);
      assert.equal(opts.env.CODEX_HOME,codexHome);assert.notEqual(opts.cwd,process.cwd());
      return current?{code:0,stdout:JSON.stringify(current)}:{code:1,stderr:"No MCP server named 'nerve' found"};
    },
    writeConfig:async({edits})=>{
      writes++;current ??= {transport:{}};
      for(const {keyPath,value} of edits) {
        const key=keyPath.replace('mcp_servers.nerve.','');
        if(key==='enabled')current.enabled=value;
        else if(key==='env.NERVE_CONFIG')(current.transport.env ??= {}).NERVE_CONFIG=value;
        else current.transport[key]=value;
      }
    }};
  return {home,privateDir,options,get current(){return current;},set current(value){current=value;},get writes(){return writes;}};
}
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function existing(f,extra={}) {
  const configPath=join(f.privateDir,'nerve.json');
  await writeFile(configPath,JSON.stringify({database:'custom.sqlite',port:19873,targets:{},...extra}));
  await writeFile(join(f.privateDir,'secrets.json'),JSON.stringify({NERVE_TOKEN:'x'.repeat(32),OTHER:'keep'}));
  return configPath;
}

test('fresh installation initializes idle Nerve and preserves other daemon and secret settings',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({chat:'chat.json',custom:42}));
  await writeFile(join(f.privateDir,'secrets.json'),JSON.stringify({OTHER:'keep'}));
  const result=await ensureNerveMcp(f.options),config=await json(result.configPath);
  assert.equal(result.initialized,true);assert.equal(result.needsActivation,true);
  assert.deepEqual(config.targets,{});assert.equal('triggers' in config,false);
  assert.ok(config.port>0 && config.port<=65535);
  assert.deepEqual(await json(join(f.privateDir,'daemon.json')),{chat:'chat.json',custom:42,nerve:result.configPath});
  const secrets=await json(join(f.privateDir,'secrets.json'));
  assert.equal(secrets.OTHER,'keep');assert.equal(secrets.NERVE_TOKEN.length,64);
  assert.equal(f.current.enabled,true);assert.equal(f.current.transport.env.NERVE_CONFIG,result.configPath);
  assert.deepEqual(await json(join(f.privateDir,'nerve-setup-pending.json')),{configPath:result.configPath});
  const again=await ensureNerveMcp(f.options);
  assert.equal(again.initialized,false);assert.equal(again.registered,false);assert.equal(again.needsActivation,true);assert.equal(f.writes,1);
  await rm(join(f.privateDir,'nerve-setup-pending.json'));
  assert.equal((await ensureNerveMcp(f.options)).needsActivation,false);
  assert.deepEqual(await json(join(f.privateDir,'secrets.json')),secrets);
});

test('migrates owned release entry without changing disabled flag, env, config or daemon',async t=>{
  const f=await fixture(t),configPath=await existing(f);
  await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({chat:'chat.json',nerve:'nerve.json'}));
  const before=await readFile(configPath,'utf8');
  f.current={enabled:false,disabled_tools:['nerve_send_chat'],transport:{command:'/old-node',args:[join(f.home,'releases','a'.repeat(40),'src','nerve-mcp.mjs')],env:{NERVE_CONFIG:configPath,OTHER:'keep'}}};
  const result=await ensureNerveMcp(f.options);
  assert.equal(result.initialized,false);assert.equal(result.daemonChanged,false);assert.equal(result.needsActivation,false);
  assert.equal(f.current.enabled,false);assert.deepEqual(f.current.disabled_tools,['nerve_send_chat']);assert.equal(f.current.transport.env.OTHER,'keep');
  assert.deepEqual(f.current.transport.args,[join(f.home,'nerve-mcp-run.mjs')]);
  assert.equal(await readFile(configPath,'utf8'),before);
  assert.equal((await json(join(f.privateDir,'daemon.json'))).nerve,'nerve.json');
});

test('adopts transitional entry only when its config matches daemon',async t=>{
  const f=await fixture(t),configPath=await existing(f);
  await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({nerve:configPath}));
  f.current={transport:{command:'/node',args:['/old/source/src/nerve-mcp.mjs'],env:{NERVE_CONFIG:configPath}}};
  assert.equal((await ensureNerveMcp(f.options)).registered,true);
});

test('unknown entry and path conflicts fail before creating files',async t=>{
  const f=await fixture(t);
  f.current={transport:{command:'/other',args:[]}};
  await assert.rejects(ensureNerveMcp(f.options),/unrelated/);
  await assert.rejects(access(join(f.privateDir,'nerve.json')));
  await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({nerve:'expected.json'}));
  f.current={transport:{command:'/node',args:[join(f.home,'nerve-mcp-run.mjs')],env:{NERVE_CONFIG:'/elsewhere/nerve.json'}}};
  await assert.rejects(ensureNerveMcp(f.options),/conflict/);
  assert.equal(f.writes,0);
});

test('missing or invalid existing configuration and token are never replaced',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({nerve:'nerve.json'}));
  await assert.rejects(ensureNerveMcp(f.options),/file is missing/);
  await existing(f);
  await writeFile(join(f.privateDir,'secrets.json'),JSON.stringify({NERVE_TOKEN:'short'}));
  await assert.rejects(ensureNerveMcp(f.options),/valid NERVE_TOKEN/);
  assert.equal((await json(join(f.privateDir,'secrets.json'))).NERVE_TOKEN,'short');assert.equal(f.writes,0);
});

test('inspection error is not treated as an absent server',async t=>{
  const f=await fixture(t);
  await assert.rejects(ensureNerveMcp({...f.options,run:async()=>({code:2,stderr:'bad TOML'})}),/Could not inspect/);
  await assert.rejects(access(join(f.privateDir,'nerve.json')));assert.equal(f.writes,0);
});

test('failed registration leaves daemon untouched and valid setup can be retried',async t=>{
  const f=await fixture(t);
  await assert.rejects(ensureNerveMcp({...f.options,writeConfig:async()=>{throw new Error('write failed');}}),/write failed/);
  await assert.rejects(access(join(f.privateDir,'daemon.json')));
  const secrets=await json(join(f.privateDir,'secrets.json'));
  const result=await ensureNerveMcp(f.options);
  assert.equal(result.initialized,false);assert.equal(result.daemonChanged,true);assert.equal(result.needsActivation,true);
  assert.deepEqual(await json(join(f.privateDir,'secrets.json')),secrets);
});


test('update preserves producer configuration without checking or migrating it',async t=>{
  for(const producerConfig of [{triggers:[]},{triggers:[{id:'daily',daily:'03:00',target:'main'}]},{attention:{},minecraft:{},customProducer:{enabled:true}}]) {
    const f=await fixture(t),configPath=await existing(f,producerConfig);
    await writeFile(join(f.privateDir,'daemon.json'),JSON.stringify({nerve:'nerve.json'}));
    const before=await readFile(configPath,'utf8');
    const result=await ensureNerveMcp(f.options);
    assert.equal(result.initialized,false);
    assert.equal(await readFile(configPath,'utf8'),before);
    await ensureNerveMcp(f.options);
    assert.equal(await readFile(configPath,'utf8'),before);
    assert.equal((await json(join(f.privateDir,'secrets.json'))).OTHER,'keep');
  }
});
