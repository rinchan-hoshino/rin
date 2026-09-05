import { readFile, writeFile, mkdir, rename, realpath, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installHome, REPOSITORY, exists, run, withInstallLock, prepareRelease, atomicJSON } from './core.mjs';
import { createService } from './service.mjs';
import { installProducts, installHistoryTool, historySupport } from './products.mjs';

const quoteSh = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function ensureCommandPath(binDir, { userHome = homedir(), platform = process.platform, env = process.env, exec = run } = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  if ((env.PATH || '').split(separator).some(path => resolve(path || '.') === resolve(binDir))) return;
  if (platform === 'win32') {
    const literal = `'${binDir.replaceAll("'", "''")}'`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';$dir=${literal};$old=[Environment]::GetEnvironmentVariable('Path','User');if(($old -split ';') -notcontains $dir){[Environment]::SetEnvironmentVariable('Path',($dir+';'+$old),'User')}`]);
  } else {
    const shell = (env.SHELL || '').split('/').at(-1);
    const files = shell === 'zsh' ? ['.zshrc'] : shell === 'fish' ? ['.config/fish/config.fish'] : ['.bashrc', await exists(join(userHome, '.bash_profile')) ? '.bash_profile' : '.profile'];
    const line = shell === 'fish' ? `fish_add_path --path ${quoteSh(binDir)}` : `export PATH=${quoteSh(binDir)}:"$PATH"`;
    for (const name of files) {
      const file = join(userHome, name);
      await mkdir(dirname(file), { recursive: true });
      const previous = await exists(file) ? await readFile(file, 'utf8') : '';
      if (!previous.includes(line)) await writeFile(file, `${previous.trimEnd()}\n\n# Rin command path\n${line}\n`, { mode: 0o600 });
    }
  }
}
export async function inspectLegacy({ userHome = homedir(), env = process.env } = {}) {
  const root = join(userHome, '.rin');
  let record;
  try { record = JSON.parse(await readFile(join(root, 'installer.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot inspect the old Rin installation record'); }
  if (!record && !await exists(join(root, 'app/current'))) return null;
  const cli = [];
  const names = process.platform === 'win32' ? ['rin.cmd', 'rin.ps1', 'rin'] : ['rin'];
  for (const directory of new Set([join(userHome, '.local/bin'), ...(env.PATH || '').split(process.platform === 'win32' ? ';' : ':')].filter(Boolean))) {
    for (const name of names) {
      const file = join(directory, name);
      try {
        const target = await realpath(file), text = (await readFile(file, 'utf8')).slice(0, 16384);
        const below = relative(root, target);
        const legacyText = text.replaceAll('\\', '/').toLowerCase(), rootText = root.replaceAll('\\', '/').toLowerCase();
        if ((below && !below.startsWith('..') && !isAbsolute(below) || legacyText.includes(rootText) || legacyText.includes('.rin/app/current')) && /rin|dist\/index/i.test(text)) cli.push(file);
      } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EISDIR') throw e; }
    }
  }
  return { root, service: record?.service, cli: [...new Set(cli)] };
}
export async function disableLegacy(legacy, { exec = run, platform = process.platform, uid = process.getuid?.() } = {}) {
  if (!legacy) return;
  for (const file of legacy.cli) if (await exists(`${file}.pi-disabled`)) throw new Error(`A disabled legacy launcher already exists: ${file}.pi-disabled`);
  const service = legacy.service;
  if (service?.kind === 'launchd') {
    if (!/^com\.rin\.daemon\.[a-zA-Z0-9_-]+$/.test(service.label)) throw new Error('Unrecognized legacy service label; inspect it before migration');
    const target = `gui/${uid}/${service.label}`;
    await exec('launchctl', ['disable', target]);
    const status = await exec('launchctl', ['print', target], { capture: true, allowFailure: true });
    if (status.code === 0) await exec('launchctl', ['bootout', target]);
  } else if (service?.kind === 'systemd') {
    const unit = service.label || service.unit || service.name;
    if (!/^rin-daemon-[a-zA-Z0-9_-]+\.service$/.test(unit || '')) throw new Error('Unrecognized legacy systemd unit; inspect it before migration');
    await exec('systemctl', ['--user', 'disable', '--now', unit]);
  } else if (service?.kind === 'windows-startup' && platform === 'win32') {
    const node = join(legacy.root, 'runtime/node/current/node.exe');
    const entry = join(legacy.root, 'app/current/dist/app/rin/main.js');
    if (!await exists(node) || !await exists(entry)) throw new Error('The legacy Windows CLI is missing; stop its daemon before continuing');
    await exec(node, [entry, 'stop']);
    const startup = service.path || service.servicePath;
    if (!startup || !/[\\/]Rin Daemon\.cmd$/.test(startup)) throw new Error('Unrecognized legacy startup launcher');
    if (await exists(startup)) await rename(startup, `${startup}.pi-disabled`);
  } else if (service || !legacy.service) {
    throw new Error('The legacy service record is missing or unsupported. Inspect its shutdown and autostart before retrying.');
  }
  for (const file of legacy.cli) {
    const disabled = `${file}.pi-disabled`;
    if (await exists(disabled)) throw new Error(`A disabled legacy launcher already exists: ${disabled}`);
    await rename(file, disabled);
  }
}

export async function writeLaunchers(home, { binDir, node = process.execPath, platform = process.platform, publish = true } = {}) {
  await mkdir(binDir, { recursive: true });
  // Both stable entrypoints read the same atomic record. Updating never rewrites live source.
  const load = `import{readFileSync}from'node:fs';import{join,dirname,delimiter}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';\nconst home=dirname(fileURLToPath(import.meta.url));process.env.PATH=dirname(process.execPath)+delimiter+(process.env.PATH||'');const state=JSON.parse(readFileSync(join(home,'install.json'),'utf8'));if(!/^[a-f0-9]{40}$/.test(state.current))throw Error('Invalid Rin release');\n`;
  await writeFile(join(home, 'launcher.mjs'), load + `const{main}=await import(pathToFileURL(join(home,'releases',state.current,'src/cli.mjs')));try{process.exitCode=await main(process.argv.slice(2),{home});}catch(e){console.error(e.message);process.exitCode=1;}\n`);
  await writeFile(join(home, 'daemon-run.mjs'), load + `
import{writeFileSync,renameSync,unlinkSync}from'node:fs';
process.env.RIN_MANAGED_DAEMON='1';
const ready=join(home,'private/daemon-ready.json');
const clean=()=>{try{if(JSON.parse(readFileSync(ready,'utf8')).pid===process.pid)unlinkSync(ready);}catch(e){if(e.code!=='ENOENT')throw e;}};
const{startDaemon}=await import(pathToFileURL(join(home,'releases',state.current,'src/daemon.mjs')));
let daemon;
try{
  daemon=await startDaemon(join(home,'private/daemon.json'));
  let stopping;
  const stop=()=>stopping||=daemon.stop().then(()=>{clean();process.exitCode=0;},e=>{console.error(e.message);process.exitCode=1;});
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  writeFileSync(ready+'.'+process.pid,JSON.stringify({pid:process.pid,current:state.current}),{mode:0o600});
  renameSync(ready+'.'+process.pid,ready);
}catch(e){await daemon?.stop();clean();console.error(e.message);process.exitCode=1;}
`);
  if (!publish) return;
  const file = join(binDir, platform === 'win32' ? 'rin.cmd' : 'rin');
  if (await exists(file)) {
    const text = await readFile(file, 'utf8');
    if (!text.includes(join(home, 'launcher.mjs'))) throw new Error(`Refusing to replace an unrelated launcher: ${file}`);
  }
  if (platform === 'win32') {
    if (/["%\r\n]/.test(node + home)) throw new Error('The installation path contains unsupported Windows command characters');
    await writeFile(file, `@echo off\r\n"${node}" "${join(home, 'launcher.mjs')}" %*\r\n`);
  } else await writeFile(file, `#!/bin/sh\nexec ${quoteSh(node)} ${quoteSh(join(home, 'launcher.mjs'))} "$@"\n`, { mode: 0o755 });
  return file;
}

export async function collectChoices(ask, say, { hasAgents = false, legacy = null } = {}) {
  say('Rin for Codex — Git installation');
  if (legacy) {
    say('An old Pi-based Rin installation was found. Continuing will disable its service and CLI launchers. Its private data will be retained.');
    if (!/^y(?:es)?$/i.test((await ask('Continue with the old Rin cutover? [y/N] ')).trim())) throw new Error('Installation cancelled');
  }
  say('Products: 1) Codex CLI  2) ChatGPT desktop app. Select both with 1,2, or leave blank to use existing products.');
  let selected;
  while (true) {
    const input = (await ask('Install products: ')).trim();
    selected = input ? [...new Set(input.split(/[,\s]+/))] : [];
    if (selected.every(x => ['1', '2'].includes(x))) break;
    say('Enter 1, 2, 1,2, or leave blank.');
  }
  const recommendations = /^y(?:es)?$/i.test((await ask('Use Rin recommended settings when a reviewed profile is available? [y/N] ')).trim());
  say('No recommendation profile is included in this version. Existing Codex settings will be preserved.');
  let agents = '';
  if (!hasAgents || /^y(?:es)?$/i.test((await ask('Global AGENTS.md already exists. Append your new instructions? [y/N] ')).trim())) {
    say('Write your initial global AGENTS instructions. Suggested topics: agent role, working principles, and communication preferences.');
    say('Finish with a single period (.) on its own line. Leave empty to skip.');
    const lines = [];
    for (;;) { const line = await ask('> '); if (line === '.') break; lines.push(line); }
    agents = lines.join('\n').trim();
  }
  const history = /^y(?:es)?$/i.test((await ask('Install the optional original-session text search tool (FFF MCP)? [y/N] ')).trim());
  return { products: selected.map(x => x === '1' ? 'codex' : 'chatgpt'), recommendations, agents, history };
}

export async function setup({ home = installHome(), repository = REPOSITORY, binDir = join(homedir(), '.local/bin'), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Rin requires Node.js 24 or newer');
  if (!process.stdin.isTTY) throw new Error('Run the installer in an interactive terminal');
  if (await exists(join(home, 'install.json'))) throw new Error('Rin is already installed here. Use rin update.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const legacy = await inspectLegacy();
    const agentsPath = join(codexHome, 'AGENTS.md');
    const choices = await collectChoices(q => rl.question(q), console.log, { hasAgents: await exists(agentsPath), legacy });
    if (choices.history && !historySupport().supported) throw new Error(historySupport().reason);
    const destination = join(binDir, process.platform === 'win32' ? 'rin.cmd' : 'rin');
    if (await exists(destination) && !legacy?.cli.includes(destination) && !(await readFile(destination, 'utf8')).includes(join(home, 'launcher.mjs'))) throw new Error(`An unrelated launcher already exists: ${destination}`);
    return await withInstallLock(home, async () => {
      const candidate = await prepareRelease(home, { repository });
      // Finish downloads and candidate validation before disabling the legacy runtime.
      await installProducts({ products: choices.products, home });
      await mkdir(join(home, 'private/logs'), { recursive: true, mode: 0o700 });
      await mkdir(codexHome, { recursive: true, mode: 0o700 });
      if (choices.agents) {
        const previous = await exists(agentsPath) ? await readFile(agentsPath, 'utf8') : '';
        await writeFile(agentsPath, previous ? `${previous.trimEnd()}\n\n${choices.agents}\n` : `${choices.agents}\n`, { mode: 0o600 });
      }
      if (!await exists(join(home, 'private/daemon.json'))) await atomicJSON(join(home, 'private/daemon.json'), { chat: null, nerve: null });
      await writeLaunchers(home, { binDir, publish: false });
      const service = createService({ home, node: process.execPath, env: { ...process.env, PATH: [binDir, dirname(process.execPath), process.env.PATH || ''].join(process.platform === 'win32' ? ';' : ':') } });
      await service.install();
      if (choices.history) {
        const tool = await installHistoryTool({ home, codexHome });
        console.log(tool.registered ? 'Original-session text search is registered.' : 'An existing session-history MCP entry was preserved. The downloaded tool has not replaced it.');
      }
      // Service registration and auxiliary setup must succeed before the old CLI is disabled.
      await disableLegacy(legacy);
      let launcher;
      try {
        launcher = await writeLaunchers(home, { binDir });
        await atomicJSON(join(home, 'install.json'), { schema: 1, type: 'git', repository, current: candidate.sha, previous: null, node: process.execPath, binDir, recommendationsRequested: choices.recommendations });
      } catch (error) {
        for (const file of legacy?.cli || []) {
          if (await exists(`${file}.pi-disabled`)) { await rm(file, { force: true }); await rename(`${file}.pi-disabled`, file); }
        }
        throw new Error(`Installation cutover failed: ${error.message}. Legacy CLI launchers were restored; its service remains stopped.`);
      }
      await ensureCommandPath(binDir);
      const daemon = JSON.parse(await readFile(join(home, 'private/daemon.json'), 'utf8'));
      if ((daemon.chat || daemon.nerve) && /^y(?:es)?$/i.test((await rl.question('Configured background services were found. Start Rin now? [y/N] ')).trim())) await service.start();
      else console.log('The daemon is installed but stopped. Codex CLI use does not need it. Configure private/daemon.json, then run rin start when you need background work.');
      console.log(`Rin installed: ${launcher}\nOpen a new terminal to load the command path. Run rin to use Codex; rin update updates this Git installation.`);
      return { home, release: candidate.sha };
    });
  } finally { rl.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) setup().catch(e => { console.error(e.message); process.exitCode = 1; });
