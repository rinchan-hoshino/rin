#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installHome, readInstall, withInstallLock, prepareRelease, switchRelease, codexCommand } from './install/core.mjs';
import { createService } from './install/service.mjs';
import { runUpdateMigrations } from './install/migrations.mjs';

export function routeArgs(args) {
  if (args[0] === '--') return { type: 'codex', args: args.slice(1) };
  if (['update', 'start', 'stop', 'restart'].includes(args[0])) {
    if (args.length !== 1) throw new Error(`rin ${args[0]} takes no arguments. Use rin -- to pass arguments directly to Codex.`);
    return { type: 'rin', command: args[0] };
  }
  return { type: 'codex', args };
}
export async function main(args = process.argv.slice(2), { home = installHome(), serviceFactory = createService, codex = process.env.RIN_CODEX_BIN, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), writeConfig, prepare = prepareRelease, switchTo = switchRelease } = {}) {
  const route = routeArgs(args);
  if (route.type === 'codex') {
    const executable = await codexCommand({ binary: codex });
    // Inherit the user's terminal, cwd, environment and permissions unchanged.
    return await new Promise((accept, reject) => {
      const child = spawn(executable.command, [...executable.args, ...route.args], { stdio: 'inherit' });
      const forward = signal => { try { child.kill(signal); } catch {} };
      const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
      child.once('error', e => { cleanup(); reject(new Error(e.code === 'ENOENT' ? 'Codex CLI was not found. Install Codex CLI or set RIN_CODEX_BIN to its executable.' : e.message)); });
      child.once('exit', (code, signal) => { cleanup(); accept(code ?? (signal === 'SIGINT' ? 130 : 143)); });
    });
  }
  if (process.env.RIN_MANAGED_DAEMON === '1') throw new Error('Run Rin service management from a separate terminal to avoid stopping its own task.');
  return withInstallLock(home, async () => {
    const state = await readInstall(home);
    const service = serviceFactory({ home, node: state.node });
    if (route.command === 'update') {
      const candidate = await prepare(home, { repository: state.repository, current: state.current });
      const migrate = candidate.changed
        ? (await import(pathToFileURL(join(candidate.release, 'src/install/migrations.mjs')).href)).runUpdateMigrations
        : runUpdateMigrations;
      await migrate({codexHome,binary:codex,writeConfig});
      if (!candidate.changed) { console.log('Rin is already up to date.'); return 0; }
      await switchTo(home, candidate, state, service);
      console.log(`Rin updated to ${candidate.sha.slice(0, 12)}.`);
    } else {
      if (route.command !== 'stop') {
        const config = JSON.parse(await readFile(join(home, 'private/daemon.json'), 'utf8'));
        if (!config.chat && !config.nerve) throw new Error('No background work is configured. Set chat and/or nerve in private/daemon.json before rin start.');
      }
      if (route.command !== 'start') await service.stop();
      if (route.command !== 'stop') await service.start();
      console.log(`Rin ${route.command === 'stop' ? 'stopped' : 'started'}.`);
    }
    return 0;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = 1; });
}
