#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {agentCommand} from './agents/command.js';
import {readConfig} from './rin.js';
import type {AgentConfig} from './agents/types.js';
import {homedir,constants} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installHome,readInstall,withInstallLock,prepareRelease,switchRelease} from './install/core.js';
import {createService} from './install/service.js';
import {ensureAppServer,prepareAppServerRestart,prepareAppServerStop} from './codex-server-lifecycle.js';

export interface CliOptions {
  home?: string;
  serviceFactory?: typeof createService;
  codex?: string;
  codexHome?: string;
  prepare?: typeof prepareRelease;
  switchTo?: typeof switchRelease;
  ensureServer?: typeof ensureAppServer;
  prepareServerRestart?: typeof prepareAppServerRestart;
  prepareServerStop?: typeof prepareAppServerStop;
}

type RinCommand='update'|'start'|'stop'|'restart';
type Route={type:'rin';command:RinCommand}|{type:'codex';command:'start'|'stop'|'restart'}|{type:'agent';args:string[]};

export function routeArgs(args:string[]):Route {
  if(!args.length)return {type:'agent',args:[]};
  if(args[0]==='--')return {type:'agent',args:args.slice(1)};
  if(args.length===1 && ['update','start','stop','restart'].includes(args[0]))return {type:'rin',command:args[0] as RinCommand};
  if(args.length===2 && args[0]==='codex' && ['start','stop','restart'].includes(args[1]))return {type:'codex',command:args[1] as 'start'|'stop'|'restart'};
  throw new Error('Usage: rin [-- CLI_ARGS] | rin update|start|stop|restart | rin codex start|stop|restart');
}

async function configuredAgent(home:string, required=true):Promise<AgentConfig> {
  const daemon=JSON.parse(await readFile(join(home,'private/daemon.json'),'utf8'));
  if(!daemon.chat) {
    if(required)throw new Error('Configure a chat agent before launching its CLI with rin.');
    return {type:'codex'};
  }
  return readConfig(resolve(home,'private',daemon.chat)).agent!;
}

async function launchAgent(config:AgentConfig,args:string[]):Promise<number> {
  const executable=agentCommand(config);
  return new Promise((accept,reject)=>{
    const child=spawn(executable.command,[...executable.args,...args],{stdio:'inherit',env:executable.env,...('cwd' in executable && executable.cwd ? {cwd:executable.cwd} : {})});
    const forward=(signal:NodeJS.Signals)=>{try{child.kill(signal);}catch{}};
    const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    const cleanup=()=>{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',(code,signal)=>{cleanup();accept(code ?? (128+(signal?constants.signals[signal]:1)));});
  });
}

export async function main(args=process.argv.slice(2),{
  home=installHome(),serviceFactory=createService,codex=process.env.RIN_CODEX_BIN,codexHome,
  prepare=prepareRelease,switchTo=switchRelease,ensureServer=ensureAppServer,prepareServerRestart=prepareAppServerRestart,prepareServerStop=prepareAppServerStop,
}:CliOptions={}):Promise<number>{
  const route=routeArgs(args);
  if(route.type==='agent')return launchAgent(await configuredAgent(home),route.args);
  if(process.env.RIN_MANAGED_DAEMON==='1')throw new Error('Run Rin lifecycle commands from a separate terminal.');
  return withInstallLock(home,async()=>{
    const state=await readInstall(home);
    if(route.type==='codex'){
      const agent=await configuredAgent(home,false);
      const configured=agent.type==='codex' ? agent : {type:'codex' as const};
      const options={...configured,codexHome:codexHome || configured.codexHome || process.env.CODEX_HOME || join(homedir(),'.codex'),
        command:configured.command || (codex ? [codex] : undefined)};
      if(route.command==='start')await ensureServer(options);
      else if(route.command==='stop')await (await prepareServerStop(options))();
      else await (await prepareServerRestart(options))();
      console.log(`Codex app-server ${route.command==='start'?'ready':route.command==='stop'?'stopped':'restarted'}.`);
      return 0;
    }
    const service=serviceFactory({home,node:state.node,userHome:process.env.HOME || process.env.USERPROFILE || homedir(),serviceId:state.serviceId});
    if(route.command==='update'){
      const candidate=await prepare(home,{repository:state.repository,current:state.current});
      if(!candidate.changed){console.log('Rin is already up to date.');return 0;}
      await switchTo(home,candidate,state,service);
      console.log(`Rin updated to ${candidate.sha.slice(0,12)}.`);
      return 0;
    }
    if(route.command!=='start')await service.stop();
    if(route.command!=='stop')await service.start();
    console.log(`Rin ${route.command==='stop'?'stopped':'started'}.`);
    return 0;
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().then(code=>{process.exitCode=code;},error=>{console.error(error.message);process.exitCode=1;});
}
