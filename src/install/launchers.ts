import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {exists} from './core.js';

const quoteSh=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const load=`import{readFileSync}from'node:fs';import{join,dirname,delimiter}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';\nconst home=dirname(fileURLToPath(import.meta.url));process.env.PATH=dirname(process.execPath)+delimiter+(process.env.PATH||'');const state=JSON.parse(readFileSync(join(home,'install.json'),'utf8'));if(!/^[a-f0-9]{40}$/.test(state.current))throw Error('Invalid Rin release');\n`;

export async function writeLaunchers(home:string,{binDir=join(homedir(),'.local','bin'),node=process.execPath,platform=process.platform,publish=true}:{binDir?:string;node?:string;platform?:NodeJS.Platform;publish?:boolean}={}){
  if(!resolve(home) || !resolve(binDir))throw new Error('home and binDir are required');
  await mkdir(home,{recursive:true,mode:0o700});await mkdir(binDir,{recursive:true});
  await writeFile(join(home,'launcher.mjs'),load+`const{main}=await import(pathToFileURL(join(home,'releases',state.current,'src/cli.mjs')));try{process.exitCode=await main(process.argv.slice(2),{home});}catch(e){console.error(e.message);process.exitCode=1;}\n`);
  await writeFile(join(home,'nerve-mcp-run.mjs'),load+`try{const{main}=await import(pathToFileURL(join(home,'releases',state.current,'src/nerve-mcp.mjs')));await main();}catch{process.stderr.write('Nerve MCP failed to start; check installation and private configuration.\\n');process.exitCode=1;}\n`);
  await writeFile(join(home,'daemon-run.mjs'),load+`
import{writeFileSync,renameSync,unlinkSync}from'node:fs';
process.env.RIN_MANAGED_DAEMON='1';const ready=join(home,'private/daemon-ready.json');
const clean=()=>{try{if(JSON.parse(readFileSync(ready,'utf8')).pid===process.pid)unlinkSync(ready);}catch(e){if(e.code!=='ENOENT')throw e;}};
const{startDaemon}=await import(pathToFileURL(join(home,'releases',state.current,'src/daemon.mjs')));let daemon;
try{daemon=await startDaemon(join(home,'private/daemon.json'));let stopping;const stop=()=>stopping||=daemon.stop().then(()=>{clean();process.exitCode=0;},e=>{console.error(e.message);process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);writeFileSync(ready+'.'+process.pid,JSON.stringify({pid:process.pid,current:state.current}),{mode:0o600});renameSync(ready+'.'+process.pid,ready);}catch(e){await daemon?.stop();clean();console.error(e.message);process.exitCode=1;}
`);
  if(!publish)return;
  const file=join(binDir,platform==='win32'?'rin.cmd':'rin');
  if(await exists(file) && !(await readFile(file,'utf8')).includes(join(home,'launcher.mjs')))throw new Error(`Refusing to replace an unrelated launcher: ${file}`);
  if(platform==='win32'){
    if(/["%\r\n]/.test(node+home))throw new Error('The installation path contains unsupported Windows command characters');
    await writeFile(file,`@echo off\r\n"${node}" "${join(home,'launcher.mjs')}" %*\r\n`);
  }else await writeFile(file,`#!/bin/sh\nexec ${quoteSh(node)} ${quoteSh(join(home,'launcher.mjs'))} "$@"\n`,{mode:0o755});
  return file;
}
