import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
test('notification adapter requires a fixed destination and preserves literal text',()=>{
 const dir=mkdtempSync(join(tmpdir(),'notify-'));const fake=join(dir,'cc-connect');
 try{
  writeFileSync(fake,`#!${process.execPath}\nlet s='';for await(const b of process.stdin)s+=b;console.log(JSON.stringify({args:process.argv.slice(2),text:s,hasToken:!!process.env.NERVE_TOKEN}));`,{mode:0o700});
  const text='hello; $(nothing) 中文测试';
  const r=spawnSync(process.execPath,[resolve('src/cc-notify.mjs'),'example','test:local'],{input:JSON.stringify({payload:{text}}),encoding:'utf8',env:{...process.env,CC_CONNECT_BIN:fake,NERVE_TOKEN:'secret'}});
  assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.text,text);assert.equal(out.hasToken,false);assert.ok(out.args.includes('test:local'));
  const missing=spawnSync(process.execPath,[resolve('src/cc-notify.mjs'),'example'],{input:'{}',encoding:'utf8'});assert.notEqual(missing.status,0);assert.match(missing.stderr,/Explicit project/);
 }finally{rmSync(dir,{recursive:true});}
});
