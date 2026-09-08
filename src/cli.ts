#!/usr/bin/env node
import {errorCode} from './install/types.js';
import type {ConfigWriter} from './install/profile.js';
import type {ensureNerveMcp} from './install/nerve.js';
import {ensureAppServer, prepareAppServerRestart} from './codex-server-lifecycle.js';
export interface CliOptions {home?: string;serviceFactory?: typeof createService;codex?: string;codexHome?: string;writeConfig?: ConfigWriter;prepare?: typeof prepareRelease;switchTo?: typeof switchRelease;ensureMcp?: typeof ensureNerveMcp;activateMcp?: typeof activateNerveMcp;ensureServer?:typeof ensureAppServer;prepareServerRestart?:typeof prepareAppServerRestart}
type Route = {type: 'codex';args: string[]} | {type:'rin';command: string;appServer?:boolean};
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installHome, readInstall, withInstallLock, prepareRelease, switchRelease, codexCommand } from './install/core.js';
import { createService } from './install/service.js';
import { runUpdateMigrations } from './install/migrations.js';
import {activateNerveMcp} from './install/nerve-service.js';

export function routeArgs(args: string[]): Route {
  if (args[0] === '--') return { type: 'codex', args: args.slice(1) };
  if (['update', 'start', 'stop', 'restart'].includes(args[0])) {
    if (args[0] === 'restart' && args.length === 2 && args[1] === '--app-server') return {type:'rin',command:'restart',appServer:true};
    if (args.length !== 1) throw new Error(`rin ${args[0]} takes no arguments. Use rin -- to pass arguments directly to Codex.`);
    return { type: 'rin', command: args[0] };
  }
  return { type: 'codex', args };
}
export async function main(args = process.argv.slice(2), { home = installHome(), serviceFactory = createService, codex = process.env.RIN_CODEX_BIN, codexHome, writeConfig, prepare = prepareRelease, switchTo = switchRelease, ensureMcp, activateMcp = activateNerveMcp, ensureServer = ensureAppServer, prepareServerRestart = prepareAppServerRestart }: CliOptions = {}): Promise<number> {
  const route = routeArgs(args);
  if (route.type === 'codex') {
    const executable = await codexCommand({ binary: codex });
    // Inherit the user's terminal, cwd, environment and permissions unchanged.
    return await new Promise<number>((accept, reject) => {
      const child = spawn(executable.command, [...executable.args, ...route.args], { stdio: 'inherit' });
      const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch {} };
      const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
      child.once('error', e => { cleanup(); reject(new Error(errorCode(e) === 'ENOENT' ? 'Codex CLI was not found. Install Codex CLI or set RIN_CODEX_BIN to its executable.' : e.message)); });
      child.once('exit', (code, signal) => { cleanup(); accept(code ?? (signal === 'SIGINT' ? 130 : 143)); });
    });
  }
  if (process.env.RIN_MANAGED_DAEMON === '1') throw new Error('Run Rin service management from a separate terminal to avoid stopping its own task.');
  return withInstallLock(home, async () => {
    const state = await readInstall(home);
    codexHome ||= process.env.CODEX_HOME || state.codexHome || join(homedir(), '.codex');
    const service = serviceFactory({ home, node: state.node });
    if (route.command === 'update') {
      const candidate = await prepare(home, { repository: state.repository, current: state.current });
      const migrate = candidate.changed
        ? (await import(pathToFileURL(join(candidate.release, 'src/install/migrations.mjs')).href)).runUpdateMigrations
        : runUpdateMigrations;
      const migration=await migrate({home,codexHome,binary:codex,writeConfig,service,deferActivation:candidate.changed,ensureMcp,activateMcp});
      if (!candidate.changed) { console.log('Rin is already up to date.'); return 0; }
      await switchTo(home, candidate, state, service);
      await activateMcp({home,service,nerve:migration?.nerve});
      console.log(`Rin updated to ${candidate.sha.slice(0, 12)}.`);
    } else {
      let restartServer: (()=>Promise<void>) | undefined;
      if (route.command !== 'stop') {
        const config = JSON.parse(await readFile(join(home, 'private/daemon.json'), 'utf8'));
        if (!config.chat && !config.nerve) throw new Error('No background work is configured. Set chat and/or nerve in private/daemon.json before rin start.');
        const chat = config.chat ? (await import('./rin.js')).readConfig(resolve(home,'private',config.chat)) : undefined;
        const executable = chat?.codex?.command ? undefined : await codexCommand({binary:codex});
        const options = {codexHome, ...chat?.codex, ...(executable ? {command:[executable.command,...executable.args]} : {})};
        if (route.appServer) restartServer = await prepareServerRestart(options);
        else await ensureServer(options);
      }
      if (route.command !== 'start') await service.stop();
      if (restartServer) await restartServer();
      if (route.command !== 'stop') await service.start();
      console.log(route.appServer ? 'Rin and app-server restarted.' : `Rin ${route.command === 'stop' ? 'stopped' : 'started'}.`);
    }
    return 0;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = 1; });
}
