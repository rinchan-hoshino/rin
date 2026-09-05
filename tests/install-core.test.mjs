import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareRelease, switchRelease, withInstallLock } from '../src/install/core.mjs';
import { writeLaunchers } from '../src/install/setup.mjs';
import { routeArgs } from '../src/cli.mjs';

const execFileAsync = promisify(execFile);

async function temporary(t, prefix = 'rin-core-') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function git(cwd, ...args) {
  const { stdout = '', stderr = '' } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return { code: 0, stdout, stderr };
}

async function repository(t) {
  const root = await temporary(t, 'rin-origin-');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Rin Tests');
  await git(root, 'config', 'user.email', 'rin-tests@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'config', 'core.hooksPath', join(root, '.no-hooks'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rin', type: 'module' }));
  await writeFile(join(root, 'src/cli.mjs'), 'export const version = 1;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  const first = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  return { root, first };
}

function releaseExec({ failNpm = false } = {}) {
  const npm = [];
  return {
    npm,
    exec: async (command, args, options = {}) => {
      if (command === process.execPath && /npm-cli\.js$/.test(args[0] || '')) {
        npm.push({ args, cwd: options.cwd });
        if (failNpm) throw new Error('npm validation failed');
        return { code: 0, stdout: '', stderr: '' };
      }
      assert.equal(command, 'git');
      return git(options.cwd, ...args);
    },
  };
}

test('a fast-forward candidate is verified in isolation without touching the running release', async t => {
  const repo = await repository(t);
  const home = await temporary(t);
  const running = join(home, 'releases', repo.first);
  await mkdir(running, { recursive: true });
  await writeFile(join(running, 'live-marker'), 'still running');
  await writeFile(join(repo.root, 'src/cli.mjs'), 'export const version = 2;\n');
  await git(repo.root, 'add', '.');
  await git(repo.root, 'commit', '-m', 'fast forward');
  const next = (await git(repo.root, 'rev-parse', 'HEAD')).stdout.trim();
  const runner = releaseExec();

  const candidate = await prepareRelease(home, { repository: repo.root, current: repo.first, exec: runner.exec });

  assert.deepEqual({ sha: candidate.sha, changed: candidate.changed }, { sha: next, changed: true });
  assert.equal(await readFile(join(running, 'live-marker'), 'utf8'), 'still running');
  assert.equal(await readFile(join(candidate.release, 'src/cli.mjs'), 'utf8'), 'export const version = 2;\n');
  assert.equal(JSON.parse(await readFile(join(candidate.release, '.rin-verified.json'), 'utf8')).sha, next);
  assert.deepEqual(runner.npm.map(call => call.args.slice(1)), [['ci', '--ignore-scripts'], ['test']]);
});

test('an update rejects rewritten history instead of replacing the current lineage', async t => {
  const repo = await repository(t);
  const home = await temporary(t);
  const runner = releaseExec();
  const firstCandidate = await prepareRelease(home, { repository: repo.root, exec: runner.exec });
  await git(repo.root, 'checkout', '--orphan', 'rewritten');
  await git(repo.root, 'rm', '-rf', '.');
  await mkdir(join(repo.root, 'src'));
  await writeFile(join(repo.root, 'package.json'), JSON.stringify({ name: 'rin', type: 'module' }));
  await writeFile(join(repo.root, 'src/cli.mjs'), 'export const rewritten = true;\n');
  await git(repo.root, 'add', '.');
  await git(repo.root, 'commit', '-m', 'rewritten history');
  await git(repo.root, 'branch', '-M', 'main');

  await assert.rejects(prepareRelease(home, { repository: repo.root, current: firstCandidate.sha, exec: runner.exec }));
  assert.equal(JSON.parse(await readFile(join(firstCandidate.release, '.rin-verified.json'), 'utf8')).sha, firstCandidate.sha);
});

test('failed candidate validation leaves install state and candidate directories untouched', async t => {
  const repo = await repository(t);
  const home = await temporary(t);
  await mkdir(home, { recursive: true });
  const state = { schema: 1, type: 'git', current: repo.first, node: process.execPath, sentinel: 'preserve' };
  await writeFile(join(home, 'install.json'), JSON.stringify(state));
  const runner = releaseExec({ failNpm: true });

  await assert.rejects(prepareRelease(home, { repository: repo.root, exec: runner.exec }), /npm validation failed/);

  assert.deepEqual(JSON.parse(await readFile(join(home, 'install.json'), 'utf8')), state);
  assert.deepEqual((await readdir(join(home, 'releases'))).filter(name => name.startsWith('.candidate-')), []);
  assert.equal((await readdir(join(home, 'releases'))).includes(repo.first), false);
});

test('failed service start restores the previous atomic record and restarts it', async t => {
  const home = await temporary(t);
  const oldSha = '1'.repeat(40), nextSha = '2'.repeat(40);
  const state = { schema: 1, type: 'git', repository: '/origin', current: oldSha, previous: null, node: '/old/node' };
  await writeFile(join(home, 'install.json'), JSON.stringify(state));
  const calls = [];
  let starts = 0;
  const service = {
    async isRunning() { calls.push('status'); return true; },
    async stop() { calls.push('stop'); },
    async start() { calls.push('start'); if (++starts === 1) throw new Error('new release failed readiness'); },
  };

  await assert.rejects(switchRelease(home, { sha: nextSha }, state, service), /new release failed readiness/);

  assert.deepEqual(JSON.parse(await readFile(join(home, 'install.json'), 'utf8')), state);
  assert.deepEqual(calls, ['status', 'stop', 'start', 'stop', 'start']);
});

test('install lock rejects contention and is released after the owner finishes', async t => {
  const home = await temporary(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const acquired = new Promise(resolve => { entered = resolve; });
  const owner = withInstallLock(home, async () => { entered(); await gate; return 'done'; });
  await acquired;
  await assert.rejects(withInstallLock(home, async () => 'second'), /Another install\/update may be running/);
  release();
  assert.equal(await owner, 'done');
  assert.equal(await withInstallLock(home, async () => 'next'), 'next');
});

test('CLI routing reserves exact lifecycle commands and preserves ordinary Codex argv', () => {
  assert.deepEqual(routeArgs(['start']), { type: 'rin', command: 'start' });
  assert.deepEqual(routeArgs(['stop']), { type: 'rin', command: 'stop' });
  assert.deepEqual(routeArgs(['restart']), { type: 'rin', command: 'restart' });
  assert.deepEqual(routeArgs(['update']), { type: 'rin', command: 'update' });
  assert.deepEqual(routeArgs(['--', 'start', '--quiet']), { type: 'codex', args: ['start', '--quiet'] });
  assert.deepEqual(routeArgs(['exec', 'start']), { type: 'codex', args: ['exec', 'start'] });
  assert.deepEqual(routeArgs([]), { type: 'codex', args: [] });
  assert.throws(() => routeArgs(['restart', '--force']), /takes no arguments/);
});

test('stable MCP launcher follows release changes without rewriting the entrypoint', async t => {
  const home = await temporary(t);
  await writeLaunchers(home, { binDir: join(home, 'bin'), publish: false });
  const launcher = join(home, 'nerve-mcp-run.mjs');
  const original = await readFile(launcher, 'utf8');
  for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
    const source = join(home, 'releases', sha, 'src');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'nerve-mcp.mjs'), `export async function main(){console.log(JSON.stringify({release:${JSON.stringify(sha)},config:process.env.NERVE_CONFIG}));}`);
    await writeFile(join(home, 'install.json'), JSON.stringify({ current: sha }));
    const {stdout,stderr} = await execFileAsync(process.execPath, [launcher], { env: {...process.env, NERVE_CONFIG:'/unchanged/private/nerve.json'} });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), {release:sha,config:'/unchanged/private/nerve.json'});
    assert.equal(await readFile(launcher, 'utf8'), original);
  }
});

test('stable launchers load the selected release, pass argv, and gracefully stop the daemon', async t => {
  const home = await temporary(t);
  const sha = 'a'.repeat(40);
  const source = join(home, 'releases', sha, 'src');
  const privateDir = join(home, 'private');
  const cliMarker = join(home, 'cli-marker.json');
  const readyMarker = join(home, 'daemon-ready.json');
  const stopMarker = join(home, 'daemon-stopped');
  await mkdir(source, { recursive: true });
  await mkdir(privateDir);
  await writeFile(join(home, 'install.json'), JSON.stringify({ schema: 1, type: 'git', current: sha, node: process.execPath }));
  await writeFile(join(privateDir, 'daemon.json'), JSON.stringify({ nerve: '/configured/nerve.json', chat: null }));
  await writeFile(join(source, 'cli.mjs'), `
    import { writeFile } from 'node:fs/promises';
    export async function main(args, options) {
      await writeFile(${JSON.stringify(cliMarker)}, JSON.stringify({ args, home: options.home }));
      return 7;
    }
  `);
  await writeFile(join(source, 'daemon.mjs'), `
    import { writeFile } from 'node:fs/promises';
    let timer;
    export async function startDaemon(config) {
      await writeFile(${JSON.stringify(readyMarker)}, JSON.stringify({ config, managed: process.env.RIN_MANAGED_DAEMON }));
      timer=setInterval(()=>{}, 1000);
      return { stop: async () => { clearInterval(timer); await writeFile(${JSON.stringify(stopMarker)}, 'stopped'); } };
    }
  `);
  await writeLaunchers(home, { binDir: join(home, 'bin'), publish: false });
  const canonicalHome = await realpath(home);

  const cli = spawn(process.execPath, [join(home, 'launcher.mjs'), '--', 'start', 'literal'], { stdio: 'ignore' });
  const [cliCode] = await once(cli, 'exit');
  assert.equal(cliCode, 7);
  assert.deepEqual(JSON.parse(await readFile(cliMarker, 'utf8')), { args: ['--', 'start', 'literal'], home: canonicalHome });

  await t.test('POSIX daemon launcher shuts down gracefully', { skip: process.platform === 'win32' }, async t => {
  const daemon = spawn(process.execPath, [join(home, 'daemon-run.mjs')], { stdio: 'ignore' });
  t.after(() => { if (daemon.exitCode === null) daemon.kill('SIGKILL'); });
  const deadline = Date.now() + 3000;
  let ready;
  while (!ready && Date.now() < deadline) {
    try {
      const marker = JSON.parse(await readFile(join(home, 'private/daemon-ready.json'), 'utf8'));
      assert.deepEqual(marker, { pid: daemon.pid, current: sha });
      ready = JSON.parse(await readFile(readyMarker, 'utf8'));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.deepEqual(ready, { config: join(canonicalHome, 'private', 'daemon.json'), managed: '1' });
  daemon.kill('SIGTERM');
  const [daemonCode] = await once(daemon, 'exit');
  assert.equal(daemonCode, 0);
  assert.equal(await readFile(stopMarker, 'utf8'), 'stopped');
  await assert.rejects(readFile(join(home, 'private/daemon-ready.json')), { code: 'ENOENT' });
  });
});
