#!/usr/bin/env node
// Small, agent-neutral installer entrypoint. It only prepares Rin itself;
// agent credentials and transport configuration remain in the guided prompt.
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {atomicJSON, findNpmCli, installHome, prepareRelease, REPOSITORY, run, withInstallLock} from '../../dist/install/core.js';
import {writeLaunchers} from '../../dist/install/launchers.js';
import {createService} from '../../dist/install/service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exists = path => access(path).then(() => true, () => false);
const platformBin = (platform=process.platform, env=process.env) => platform === 'win32'
  ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Rin', 'bin')
  : join(homedir(), '.local', 'bin');

async function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Rin requires Node.js 24 or newer; found ${process.versions.node}. Install Node.js 24+ and retry.`);
  try { return await findNpmCli(); }
  catch { throw new Error('Rin requires npm from Node.js 24 or newer. Install the official Node.js 24+ package so node and npm are both on PATH, then retry.'); }
}

async function verifySource() {
  const npm = await requireNode();
  if (!await exists(join(root, 'package.json'))) throw new Error('The Rin source directory is incomplete: package.json is missing. Re-download the installer and retry.');
  await run(process.execPath, [npm, 'ci', '--ignore-scripts', '--include=dev'], {cwd: root});
  await run(process.execPath, [npm, 'test'], {cwd: root});
  return (await run('git', ['rev-parse', 'HEAD'], {cwd: root, capture: true})).stdout.trim();
}

async function addCommandPath(binDir, platform=process.platform, env=process.env) {
  const separator = platform === 'win32' ? ';' : ':';
  if ((env.PATH || '').split(separator).some(item => resolve(item || '.') === resolve(binDir))) return;
  if (platform === 'win32') {
    const literal = `'${binDir.replaceAll("'", "''")}'`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop';$d=${literal};$p=[Environment]::GetEnvironmentVariable('Path','User');if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('Path',($d+';'+$p),'User')}`]);
    return;
  }
  const file = join(homedir(), env.SHELL?.endsWith('/zsh') ? '.zshrc' : '.profile');
  await mkdir(dirname(file), {recursive: true});
  const old = await exists(file) ? await readFile(file, 'utf8') : '';
  const line = `export PATH='${binDir.replaceAll("'", "'\\''")}':"$PATH"`;
  if (!old.includes(line)) await writeFile(file, `${old.trimEnd()}\n\n# Rin command path\n${line}\n`, {mode: 0o600});
}

export async function install({home=installHome(), repository=REPOSITORY, binDir=platformBin(), platform=process.platform, env=process.env}={}) {
  const sha = await verifySource();
  return withInstallLock(home, async () => {
    if (await exists(join(home, 'install.json'))) throw new Error(`Rin is already installed at ${home}; use rin update.`);
    const candidate = await prepareRelease(home, {repository});
    if (candidate.sha !== sha && repository === REPOSITORY) throw new Error('The verified source changed while preparing the release; retry the installer.');
    await mkdir(join(home, 'private', 'logs'), {recursive: true, mode: 0o700});
    await atomicJSON(join(home, 'private', 'daemon.json'), {chat: null, nerve: null});
    const serviceId = `com.rin.user-${sha.slice(0, 12)}`;
    await writeLaunchers(home, {binDir, platform, publish: true});
    const service = createService({home, node: process.execPath, platform, env: {...env, PATH: [binDir, dirname(process.execPath), env.PATH || ''].filter(Boolean).join(platform === 'win32' ? ';' : ':')}, serviceId});
    await service.install();
    await atomicJSON(join(home, 'install.json'), {schema: 1, type: 'git', repository, current: candidate.sha, previous: null, node: process.execPath, serviceId});
    await addCommandPath(binDir, platform, env);
    return {home, binDir, release: candidate.sha, serviceId};
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) install().then(result => {
  console.log(`Rin installed in ${result.home}. Open a new terminal, then run rin start after configuring the guided prompt.`);
}, error => { console.error(error.message); process.exitCode = 1; });
