import test from 'node:test';
import assert from 'node:assert/strict';
import {access,chmod,mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';

const installer=resolve('install.sh');
const missing=path=>access(path).then(()=>false,()=>true);

async function executable(path,body) { await writeFile(path,`#!/bin/sh\nset -eu\n${body}\n`);await chmod(path,0o755); }

const runtimeTest=t=>process.platform==='win32'&&t.skip('POSIX bootstrap test');

function command(command,args) { return new Promise((resolveCommand,reject)=>{const child=spawn(command,args,{stdio:'ignore'});child.once('error',reject);child.once('close',code=>code===0?resolveCommand():reject(Error(`${command} failed: ${code}`)));}); }

async function fixture(t,{nodeOk=false,legacyNode=false,gitOk=true,validNode=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'rin-bootstrap-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(root,'bin'),home=join(root,'install'),log=join(root,'calls.log'),input=join(root,'terminal-input'),testInstaller=join(root,'install.sh');await mkdir(bin);await mkdir(join(root,'src','install'),{recursive:true});await writeFile(join(root,'src','install','setup.mjs'),'// fixture');
  // Preserve installer control flow while replacing only its controlling-terminal
  // file descriptor, which the test sandbox denies even to a child PTY.
  const source=(await readFile(installer,'utf8')).replaceAll('>/dev/tty','>&2').replaceAll('</dev/tty','<"$RIN_TEST_INPUT"');
  await writeFile(testInstaller,source);await chmod(testInstaller,0o755);
  const reportedNode=legacyNode?join(homedir(),'.rin','runtime','node'):join(bin,'node');
  await executable(join(bin,'node'),`
case "\${1:-}" in
  -p) printf '%s\\n' "${reportedNode}" ;;
  -e) ${nodeOk?'exit 0':'exit 1'} ;;
  *) printf 'setup:%s\\n' "$*" >>"$TEST_LOG" ;;
esac`);
  await executable(join(bin,'git'),`if [ "\${1:-}" = --version ]; then [ "$TEST_GIT_INITIAL" = ok ] || [ -e "$TEST_GIT_INSTALLED" ]; exit $?; fi; printf 'git:%s\\n' "$*" >>"$TEST_LOG"`);
  await executable(join(bin,'curl'),`
url='';out='';while [ "$#" -gt 0 ]; do case "$1" in https://*) url=$1;; -o) shift;out=$1;; esac;shift;done
printf 'curl:%s\\n' "$url" >>"$TEST_LOG"
if [ "$TEST_VALID_NODE" = yes ]; then case "$url" in */SHASUMS256.txt) printf '%s  %s\\n' "$TEST_NODE_SHA" "$TEST_ARCHIVE" >"$out";; *) cp "$TEST_NODE_ARCHIVE" "$out";; esac
else case "$url" in */SHASUMS256.txt) printf '%064d  %s\\n' 0 "$TEST_ARCHIVE" >"$out";; *) printf 'unverified archive' >"$out";; esac; fi`);
  for(const manager of ['brew','apt-get','dnf','pacman'])await executable(join(bin,manager),`printf '${manager}:%s\\n' "$*" >>"$TEST_LOG"; : >"$TEST_GIT_INSTALLED"`);
  await executable(join(bin,'id'),`[ "\${1:-}" = -u ] && { echo 0; exit 0; }; /usr/bin/id "$@"`);
  const arch=process.arch==='arm64'?'arm64':'x64';const platform=process.platform==='darwin'?'darwin':'linux';
  const archiveName=`node-v24.18.0-${platform}-${arch}.tar.gz`,archive=join(root,archiveName),tree=join(root,`node-v24.18.0-${platform}-${arch}`);await mkdir(join(tree,'bin'),{recursive:true});
  await executable(join(tree,'bin','node'),`case "\${1:-}" in -p) printf '%s\\n' "$0";; -e) exit 0;; *) printf 'setup-managed:%s:%s\\n' "$0" "$*" >>"$TEST_LOG";; esac`);
  await command('/usr/bin/tar',['-czf',archive,'-C',root,basename(tree)]);const sha=createHash('sha256').update(await readFile(archive)).digest('hex');
  const env={...process.env,RIN_HOME:home,PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,TEST_LOG:log,TEST_ARCHIVE:archiveName,RIN_TEST_INPUT:input,TEST_INSTALLER:testInstaller,TEST_GIT_INITIAL:gitOk?'ok':'missing',TEST_GIT_INSTALLED:join(root,'git-installed'),TEST_VALID_NODE:validNode?'yes':'no',TEST_NODE_ARCHIVE:archive,TEST_NODE_SHA:sha};
  return {root,bin,home,log,env};
}

async function ptyRun(env,input='') {
  await writeFile(env.RIN_TEST_INPUT,input);
  return new Promise((accept,reject)=>{
    const child=spawn('/bin/sh',[env.TEST_INSTALLER],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',done=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('bootstrap test timed out'));},5000);
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject);
    child.once('close',code=>{if(done)return;done=true;clearTimeout(timer);accept({code,stdout,stderr});});
  });
}

test('existing non-legacy Node 24 reaches setup without downloading a managed runtime',async t=>{
  if(runtimeTest(t))return;
  const f=await fixture(t,{nodeOk:true});const result=await ptyRun(f.env);assert.equal(result.code,0,result.stderr);
  const calls=await readFile(f.log,'utf8');assert.match(calls,/setup:.*src\/install\/setup\.mjs/);assert.doesNotMatch(calls,/curl:/);assert.equal(await missing(join(f.home,'runtime')),true);
});

test('checksum mismatch never executes downloaded Node or launches setup and cleans staging',async t=>{
  if(runtimeTest(t))return;
  const f=await fixture(t);const result=await ptyRun(f.env,'y\n');assert.notEqual(result.code,0);assert.match(result.stdout+result.stderr,/checksum verification failed/);
  const calls=await readFile(f.log,'utf8');assert.match(calls,/SHASUMS256\.txt/);assert.doesNotMatch(calls,/setup:/);
  assert.equal(await missing(join(f.home,'runtime','node-v24.18.0')),true);
  const runtime=join(f.home,'runtime');const entries=await (await import('node:fs/promises')).readdir(runtime);assert.deepEqual(entries,[]);
});

test('a Node executable reported from legacy ~/.rin is rejected and replaced through verified download flow',async t=>{
  if(runtimeTest(t))return;
  const f=await fixture(t,{nodeOk:true,legacyNode:true});const result=await ptyRun(f.env,'y\n');assert.notEqual(result.code,0);
  const calls=await readFile(f.log,'utf8');assert.match(calls,/node-v24\.18\.0-(?:darwin|linux)-/);assert.doesNotMatch(calls,/setup:/);
});

test('declining missing Git consent runs no package-manager command',async t=>{
  if(runtimeTest(t))return;
  const f=await fixture(t,{nodeOk:true,gitOk:false});const result=await ptyRun(f.env,'n\n');assert.notEqual(result.code,0);assert.match(result.stdout+result.stderr,/Installation cancelled/);
  assert.equal(await missing(f.log),true);
});

test('empty machine installs stub Git, verifies and promotes managed Node, then runs setup with it',async t=>{
  if(runtimeTest(t))return;
  const f=await fixture(t,{gitOk:false,validNode:true});const result=await ptyRun(f.env,'y\n');assert.equal(result.code,0,result.stdout+result.stderr);
  const calls=await readFile(f.log,'utf8');assert.match(calls,process.platform==='darwin'?/brew:install git/:/apt-get:update/);assert.match(calls,/SHASUMS256\.txt/);
  const managed=join(f.home,'runtime','node-v24.18.0','bin','node');assert.equal(await missing(managed),false);assert.match(calls,new RegExp(`setup-managed:${managed.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')}:.*setup\\.mjs`));
  assert.deepEqual(await readdir(join(f.home,'runtime')),['node-v24.18.0']);
});

test('bootstrap source retains pinned Node and verification gates',async()=>{
  const source=await readFile(installer,'utf8');
  assert.match(source,/RIN_NODE_VERSION=24\.18\.0/);assert.match(source,/SHASUMS256\.txt/);assert.match(source,/\[ "\$actual" = "\$checksum" \]/);assert.match(source,/read -r answer <\/dev\/tty/);
});
