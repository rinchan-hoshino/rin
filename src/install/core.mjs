import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

export const REPOSITORY = 'https://github.com/rinchan-hoshino/rin.git';
export function installHome(env = process.env, platform = process.platform) {
  return resolve(env.RIN_HOME || (platform === 'win32' ? join(env.LOCALAPPDATA || homedir(), 'Rin') : join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'rin')));
}
export const exists = async path => access(path).then(() => true, () => false);
export async function findNpmCli({ node = process.execPath, platform = process.platform, env = process.env } = {}) {
  const candidates = [env.npm_execpath, join(dirname(node), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const directory of (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    candidates.push(join(directory, 'npm'), join(directory, 'node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { const path = await realpath(candidate); if (basename(path) === 'npm-cli.js') return path; }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  }
  throw new Error('npm was not found. Install Node.js 24 or newer with npm, then retry.');
}
export async function codexCommand({ binary = process.env.RIN_CODEX_BIN, platform = process.platform, env = process.env, userHome = homedir() } = {}) {
  if (binary) {
    if (/\.[cm]?js$/i.test(binary)) return { command: process.execPath, args: [binary] };
    if (!/\.cmd$/i.test(binary)) return { command: binary, args: [] };
    const entry = join(dirname(binary), 'node_modules/@openai/codex/bin/codex.js');
    if (await exists(entry)) return { command: process.execPath, args: [entry] };
    throw new Error('RIN_CODEX_BIN must point to the Codex executable or JavaScript entry, not an unknown .cmd wrapper');
  }
  const directories = [dirname(process.execPath), ...(env.PATH || '').split(platform === 'win32' ? ';' : ':'), ...(platform === 'win32' && env.APPDATA ? [join(env.APPDATA, 'npm')] : [])];
  for (const directory of directories.filter(Boolean)) {
    const native = join(directory, platform === 'win32' ? 'codex.exe' : 'codex');
    if (await exists(native)) {
      const target = await realpath(native);
      return /\.[cm]?js$/i.test(target) ? { command: process.execPath, args: [target] } : { command: native, args: [] };
    }
    if (platform === 'win32') {
      const entry = join(directory, 'node_modules/@openai/codex/bin/codex.js');
      if (await exists(entry)) return { command: process.execPath, args: [entry] };
    }
  }
  if (platform === 'darwin') {
    for (const root of ['/Applications', join(userHome, 'Applications')]) for (const app of ['ChatGPT.app', 'Codex.app']) {
      const native = join(root, app, 'Contents/Resources/codex');
      if (await exists(native)) return { command: native, args: [] };
    }
  }
  throw new Error('Codex CLI was not found. Install Codex CLI or set RIN_CODEX_BIN to its executable.');
}
export async function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const { capture = false, allowFailure = false, ...spawnOptions } = options;
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...spawnOptions });
    let stdout = '', stderr = '';
    child.stdout?.on('data', b => { stdout += b; });
    child.stderr?.on('data', b => { stderr += b; });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 || allowFailure ? accept({ code, signal, stdout, stderr }) : reject(new Error(`${command} failed (${signal || code})${capture ? `: ${stderr.trim()}` : ''}`)));
  });
}
export async function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
export async function readInstall(home) {
  const state = JSON.parse(await readFile(join(home, 'install.json'), 'utf8'));
  if (state.schema !== 1 || state.type !== 'git' || !/^[a-f0-9]{40}$/.test(state.current) || typeof state.node !== 'string') throw new Error('Invalid Rin Git installation record');
  return state;
}
export async function withInstallLock(home, fn) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'install.lock');
  try { await mkdir(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another install/update may be running. Remove install.lock only after checking that process.'); throw e; }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

// Prepare a separate Git checkout; never mutate the running release or reset user work.
export async function prepareRelease(home, { repository = REPOSITORY, current, exec = run } = {}) {
  const source = join(home, 'source.git');
  if (!await exists(source)) {
    await exec('git', ['init', '--bare', source]);
    await exec('git', ['--git-dir', source, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
    await exec('git', ['--git-dir', source, 'remote', 'add', 'origin', repository]);
  }
  const remote = (await exec('git', ['--git-dir', source, 'remote', 'get-url', 'origin'], { capture: true })).stdout.trim();
  if (remote !== repository) throw new Error('The saved Git remote does not match this installation');
  await exec('git', ['--git-dir', source, 'fetch', '--no-tags', 'origin', 'refs/heads/main:refs/heads/main']);
  const sha = (await exec('git', ['--git-dir', source, 'rev-parse', 'refs/heads/main'], { capture: true })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Git returned an invalid revision');
  if (current) await exec('git', ['--git-dir', source, 'merge-base', '--is-ancestor', current, sha]);
  if (sha === current) return { sha, changed: false };
  await mkdir(join(home, 'releases'), { recursive: true });
  const release = join(home, 'releases', sha);
  if (await exists(release)) {
    const stamp = JSON.parse(await readFile(join(release, '.rin-verified.json'), 'utf8'));
    if (stamp.sha !== sha) throw new Error('Unverified existing release; inspect it before retrying');
    const head = (await exec('git', ['-C', release, 'rev-parse', 'HEAD'], { capture: true })).stdout.trim();
    const dirty = (await exec('git', ['-C', release, 'status', '--porcelain', '--untracked-files=no'], { capture: true })).stdout.trim();
    if (head !== sha || dirty) throw new Error('The prepared release was modified; inspect it before retrying');
    await exec(process.execPath, [await findNpmCli(), 'test'], { cwd: release });
    // A prior installation attempt can have prepared this release already.
    return { sha, release, changed: true };
  }
  const staging = join(home, 'releases', `.candidate-${randomUUID()}`);
  try {
    await exec('git', ['clone', '--no-hardlinks', '--no-checkout', source, staging]);
    await exec('git', ['-C', staging, 'checkout', '--detach', sha]);
    const pkg = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
    if (pkg.name !== 'rin' || !await exists(join(staging, 'src/cli.mjs'))) throw new Error('The main branch does not contain the Codex Rin installer');
    const npm = await findNpmCli();
    await exec(process.execPath, [npm, 'ci', '--ignore-scripts'], { cwd: staging });
    await exec(process.execPath, [npm, 'test'], { cwd: staging });
    await writeFile(join(staging, '.rin-verified.json'), JSON.stringify({ sha, verifiedAt: new Date().toISOString() }));
    await rename(staging, release);
    return { sha, release, changed: true };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function switchRelease(home, candidate, state, service) {
  const running = state ? await service.isRunning() : false;
  if (running) await service.stop();
  const next = { ...state, schema: 1, type: 'git', repository: state?.repository || REPOSITORY, current: candidate.sha, previous: state?.current || null, node: process.execPath };
  try {
    await atomicJSON(join(home, 'install.json'), next);
    if (running) await service.start();
  } catch (error) {
    if (state) {
      await atomicJSON(join(home, 'install.json'), state);
      if (running) {
        try { await service.stop(); await service.start(); }
        catch (rollback) { throw new AggregateError([error, rollback], 'Update failed; previous release restored but service recovery failed'); }
      }
    }
    throw error;
  }
  return next;
}
