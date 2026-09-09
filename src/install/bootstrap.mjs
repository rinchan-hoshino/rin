#!/usr/bin/env node
// Small, agent-neutral installer entrypoint. It only prepares Rin itself;
// agent credentials and transport configuration remain in the guided prompt.
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exists = path => access(path).then(() => true, () => false);
const run = (command, args, options={}) => new Promise((resolveRun, rejectRun) => {
  import('node:child_process').then(({spawn}) => {
    const {capture=false, ...spawnOptions} = options;
    const child = spawn(command, args, {stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...spawnOptions});
    let stdout='', stderr=''; child.stdout?.on('data', b => { stdout += b; }); child.stderr?.on('data', b => { stderr += b; });
    child.once('error', rejectRun); child.once('close', code => code === 0 ? resolveRun({code, stdout, stderr}) : rejectRun(new Error(`${command} failed (${code}): ${stderr.trim() || stdout.trim()}`)));
  }, rejectRun);
});
const installHome = (env=process.env, platform=process.platform) => resolve(env.RIN_HOME || (platform === 'win32' ? join(env.LOCALAPPDATA || homedir(), 'Rin') : join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'rin')));
export const serviceIdForHome = home => `com.rin.user-${createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12)}`;
const atomicJSON = async (path, data) => { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600}); await import('node:fs/promises').then(({rename,rm}) => rename(temp, path).finally(() => rm(temp, {force:true}))); };
const withInstallLock = async (home, fn) => { await mkdir(home, {recursive:true, mode:0o700}); const lock=join(home,'install.lock'); try { await mkdir(lock); } catch { throw new Error('Another Rin install/update is already running.'); } try { return await fn(); } finally { await import('node:fs/promises').then(({rm}) => rm(lock, {recursive:true, force:true})); } };
const findNpmCli = async () => { const paths = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':'); for (const dir of paths) { const file=join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'); if (await exists(file)) return file; } const bundled=join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'); if (await exists(bundled)) return bundled; throw new Error('Rin requires npm from Node.js 24 or newer. Install the official Node.js 24+ package so node and npm are both on PATH, then retry.'); };
const REPOSITORY = 'https://github.com/rinchan-hoshino/rin.git';
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
  if (await exists(join(home, 'install.json'))) return {home, binDir, existing:true};
  const sha = await verifySource();
  return withInstallLock(home, async () => {
    if (await exists(join(home, 'install.json'))) return {home, binDir, existing:true};
    const {prepareRelease} = await import('../../dist/install/core.js');
    const {writeLaunchers} = await import('../../dist/install/launchers.js');
    const {createService} = await import('../../dist/install/service.js');
    const candidate = await prepareRelease(home, {repository, revision: sha});
    if (candidate.sha !== sha && repository === REPOSITORY) throw new Error('The verified source changed while preparing the release; retry the installer.');
    await mkdir(join(home, 'private', 'logs'), {recursive: true, mode: 0o700});
    await atomicJSON(join(home, 'private', 'daemon.json'), {chat: null, nerve: null});
    const serviceId = serviceIdForHome(home);
    await writeLaunchers(home, {binDir, platform, publish: true});
    const service = createService({home, node: process.execPath, platform, env: {...env, PATH: [binDir, dirname(process.execPath), env.PATH || ''].filter(Boolean).join(platform === 'win32' ? ';' : ':')}, serviceId});
    await service.install();
    await atomicJSON(join(home, 'install.json'), {schema: 1, type: 'git', repository, current: candidate.sha, previous: null, node: process.execPath, serviceId});
    await addCommandPath(binDir, platform, env);
    return {home, binDir, release: candidate.sha, serviceId};
  });
}

if (process.argv[1] && process.argv[1].endsWith('/src/install/bootstrap.mjs')) install().then(result => {
  console.log(`Rin installed in ${result.home}. Open a new terminal, then run rin start after configuring the guided prompt.`);
}, error => { console.error(error.message); process.exitCode = 1; });
