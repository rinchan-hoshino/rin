#!/usr/bin/env node
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {installHome,readInstall,withInstallLock,prepareRelease,switchRelease,codexCommand} from './install/core.js';
import {createService} from './install/service.js';
import {ensureAppServer,prepareAppServerRestart} from './codex-server-lifecycle.js';

export interface CliOptions {
  home?: string;
  serviceFactory?: typeof createService;
  codex?: string;
  codexHome?: string;
  prepare?: typeof prepareRelease;
  switchTo?: typeof switchRelease;
  ensureServer?: typeof ensureAppServer;
  prepareServerRestart?: typeof prepareAppServerRestart;
}

type RinCommand='update'|'start'|'stop'|'restart';
type Route={type:'rin';command:RinCommand}|{type:'app-server';command:'start'|'restart'};

export function routeArgs(args:string[]):Route {
  if(args.length===1 && ['update','start','stop','restart'].includes(args[0]))return {type:'rin',command:args[0] as RinCommand};
  if(args.length===2 && args[0]==='app-server' && ['start','restart'].includes(args[1]))return {type:'app-server',command:args[1] as 'start'|'restart'};
  throw new Error('Usage: rin update|start|stop|restart | rin app-server start|restart');
}

export async function main(args=process.argv.slice(2),{
  home=installHome(),serviceFactory=createService,codex=process.env.RIN_CODEX_BIN,codexHome,
  prepare=prepareRelease,switchTo=switchRelease,ensureServer=ensureAppServer,prepareServerRestart=prepareAppServerRestart,
}:CliOptions={}):Promise<number>{
  const route=routeArgs(args);
  if(process.env.RIN_MANAGED_DAEMON==='1')throw new Error('Run Rin lifecycle commands from a separate terminal.');
  return withInstallLock(home,async()=>{
    const state=await readInstall(home);
    if(route.type==='app-server'){
      codexHome ||= process.env.CODEX_HOME || join(homedir(),'.codex');
      const executable=await codexCommand({binary:codex});
      const options={codexHome,command:[executable.command,...executable.args]};
      if(route.command==='start')await ensureServer(options);
      else await (await prepareServerRestart(options))();
      console.log(`Codex app-server ${route.command==='start'?'ready':'restarted'}.`);
      return 0;
    }
    const service=serviceFactory({home,node:state.node});
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
