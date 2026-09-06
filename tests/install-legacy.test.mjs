import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacy, disableLegacy } from '../src/install/legacy.mjs';
async function fixture(t, platform = 'linux') {
  const userHome = await mkdtemp(join(tmpdir(), 'rin-legacy-'));
  t.after(() => rm(userHome, { recursive: true, force: true }));
  const root = join(userHome, 'custom-rin'), binDir = join(userHome, 'custom-bin');
  const put = async (file, text) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, text); };
  const entry = join(root, 'app/current/dist/app/rin/main.js'), node = join(root, 'runtime/node/current', platform === 'win32' ? 'node.exe' : 'bin/node');
  await put(entry, ''); await put(node, '');
  const cli = join(binDir, platform === 'win32' ? 'rin.cmd' : 'rin');
  // The two builders mirror legacy/pi fs-utils.ts launcherScript/windowsCmdLauncherScript.
  const script = platform === 'win32' ? `@echo off\r\nif exist "${entry}" (\r\n  "${node}" "${entry}" %*\r\n  exit /b %ERRORLEVEL%\r\n)\r\necho rin: installed runtime entry not found\r\nexit /b 1\r\n` : `#!/usr/bin/env sh\nif [ -f '${entry}' ]; then exec '${node}' '${entry}' "$@"; fi\necho "rin: installed runtime entry not found" >&2\nexit 1\n`;
  await put(cli, script);
  return { userHome, root, binDir, cli, put, platform, env: { PATH: '' } };
}
test('legacy locator resolves custom installDir and disables the generated Linux unit before backing up launchers', async t => {
  const f = await fixture(t);
  const record = join(f.userHome, '.rin/installer.json');
  await f.put(record, JSON.stringify({ installDir: f.root, targetUser: 'THE_cattail', service: { kind: 'systemd', label: 'rin-daemon-THE_cattail.service' } }));
  const settings = join(f.root, 'settings.json'); await f.put(settings, 'private');
  const result = await inspectLegacy(f); assert.deepEqual(result.cli, [f.cli]); assert.equal(result.root, f.root);
  const calls = []; await disableLegacy(result, { exec: async (...args) => { calls.push(args); assert.match(await readFile(f.cli, 'utf8'), /installed runtime/); } });
  assert.deepEqual(calls[0].slice(0, 2), ['systemctl', ['--user', 'disable', '--now', 'rin-daemon-THE_cattail.service']]);
  assert.match(await readFile(f.cli + '.pi-disabled', 'utf8'), /installed runtime/);
  assert.equal(await readFile(record + '.pi-disabled', 'utf8'), await readFile(record, 'utf8'));
  assert.equal(await readFile(settings, 'utf8'), 'private');
});
test('launcher metadata recovers Linux service using its generated file and accepts dot/@ usernames', async t => {
  const f = await fixture(t);
  await f.put(join(f.userHome, '.config/rin/install.json'), JSON.stringify({ defaultInstallDir: f.root, defaultTargetUser: 'user.name@example' }));
  const label = 'rin-daemon-user.name@example.service';
  await f.put(join(f.userHome, '.config/systemd/user', label), `[Service]\nEnvironment="RIN_DIR=${f.root}"\nExecStart="${f.root}/app/current/dist/app/rin-daemon/daemon.js"\nRestart=always\n`);
  const result = await inspectLegacy(f); assert.equal(result.service.label, label);
  await disableLegacy(result, { exec: async (command, args) => assert.deepEqual(args, ['--user', 'disable', '--now', label]) });
});
test('generated Windows launcher, custom root, startup shutdown and backup', async t => {
  const f = await fixture(t, 'win32');
  const startup = join(f.userHome, 'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/Rin Daemon.cmd');
  await f.put(startup, `@echo off\nset "RIN_DIR=${f.root}"\nstart "" /min "node.exe" "${f.root}/app/current/dist/app/rin-daemon/daemon.js"\n`);
  await f.put(join(f.userHome, 'AppData/Roaming/rin/install.json'), JSON.stringify({ defaultInstallDir: f.root, defaultTargetUser: 'example' }));
  const result = await inspectLegacy(f); assert.deepEqual(result.cli, [f.cli]);
  const calls = []; await disableLegacy(result, { platform: 'win32', exec: async (...args) => calls.push(args) });
  assert.equal(calls[0][1].at(-1), 'stop'); assert.equal(calls[0][2].env.RIN_DIR, f.root);
  assert.match(await readFile(startup + '.pi-disabled', 'utf8'), /RIN_DIR/);
});
test('all backup collisions, including dangling links, abort before service shutdown', async t => {
  const f = await fixture(t); const record = join(f.userHome, '.rin/installer.json');
  await f.put(record, JSON.stringify({ installDir: f.root, service: { kind: 'systemd', label: 'rin-daemon-example.service' } }));
  await symlink(join(f.userHome, 'missing'), record + '.pi-disabled');
  let calls = 0; await assert.rejects(disableLegacy(await inspectLegacy(f), { exec: async () => calls++ }), /already exists/); assert.equal(calls, 0);
});
test('unrelated executable remains protected even when it mentions the legacy root', async t => {
  const f = await fixture(t); await f.put(join(f.userHome, '.rin/installer.json'), JSON.stringify({ installDir: f.root }));
  await f.put(f.cli, `#!/bin/sh\n# ${f.root}\nprintf unrelated\n`);
  assert.deepEqual((await inspectLegacy(f)).cli, []);
});
test('rin-install companion is retired along with rin and Windows startup collisions are preflighted', async t => {
  const f = await fixture(t);
  await f.put(join(f.userHome, '.rin/installer.json'), JSON.stringify({ installDir: f.root, service: { kind: 'systemd', label: 'rin-daemon-example.service' } }));
  const companion = join(f.binDir, 'rin-install');
  await f.put(companion, `#!/usr/bin/env sh\nexec '${f.root}/runtime/node/current/bin/node' '${f.root}/app/current/dist/app/rin-install/main.js' "$@"\n`);
  const result = await inspectLegacy(f); assert.deepEqual(result.cli, [f.cli, companion]);
  await disableLegacy(result, { exec: async () => {} });
  assert.match(await readFile(companion + '.pi-disabled', 'utf8'), /rin-install/);
  const startup = join(f.userHome, 'Startup/Rin Daemon.cmd'); await f.put(startup + '.pi-disabled', 'prior');
  let calls = 0;
  await assert.rejects(disableLegacy({ root: f.root, cli: [], service: { kind: 'windows-startup', servicePath: startup } }, { platform: 'win32', exec: async () => calls++ }), /already exists/);
  assert.equal(calls, 0);
});
test('inaccessible cross-user root retires only this users confirmed legacy launchers and metadata', async t => {
  const f = await fixture(t);
  const metadata = join(f.userHome, '.config/rin/install.json');
  await f.put(metadata, JSON.stringify({
    defaultTargetUser: 'rin', defaultInstallDir: f.root, installedBy: 'THE_cattail'
  }));
  await chmod(join(f.root, 'installer.json'), 0o000).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  // fixture normally has no root manifest, so make the inaccessible record
  // explicit after its launcher has already been generated.
  await f.put(join(f.root, 'installer.json'), '{}');
  await chmod(join(f.root, 'installer.json'), 0o000);
  t.after(() => chmod(join(f.root, 'installer.json'), 0o600).catch(() => {}));

  const legacy = await inspectLegacy(f);
  assert.equal(legacy.inaccessibleRoot, true);
  assert.deepEqual(legacy.cli, [f.cli]);
  assert.deepEqual(legacy.records, [metadata]);
  let calls = 0;
  await disableLegacy(legacy, { exec: async () => { calls++; } });
  assert.equal(calls, 0, 'a different accounts service must not be stopped');
  assert.match(await readFile(f.cli + '.pi-disabled', 'utf8'), /installed runtime/);
  assert.equal(await readFile(metadata + '.pi-disabled', 'utf8'), await readFile(metadata, 'utf8'));
});
for (const platform of ['linux', 'win32']) test(`${platform}: recognized old launcher can be replaced in the same binDir without importing private settings`, async t => {
  const f = await fixture(t, platform);
  const { writeLaunchers } = await import('../src/install/setup.mjs');
  const startup = join(f.userHome, 'Startup/Rin Daemon.cmd');
  const service = platform === 'win32' ? { kind: 'windows-startup', servicePath: startup } : { kind: 'systemd', label: 'rin-daemon-example.service' };
  if (platform === 'win32') await f.put(startup, '@echo off\n');
  await f.put(join(f.userHome, '.rin/installer.json'), JSON.stringify({ installDir: f.root, service }));
  const settings = join(f.root, 'settings.json'); await f.put(settings, 'private settings stay here');
  const oldText = await readFile(f.cli, 'utf8');
  const legacy = await inspectLegacy(f);
  assert.ok(legacy.cli.includes(f.cli), 'setup destination collision permits the recognized legacy command');
  await disableLegacy(legacy, { platform, exec: async () => ({ code: 0 }) });
  const home = join(f.userHome, 'new-rin'); await mkdir(home);
  assert.equal(await writeLaunchers(home, { binDir: f.binDir, platform }), f.cli);
  assert.ok((await readFile(f.cli, 'utf8')).includes(join(home, 'launcher.mjs')));
  assert.equal(await readFile(f.cli + '.pi-disabled', 'utf8'), oldText);
  assert.equal(await readFile(settings, 'utf8'), 'private settings stay here');
  await assert.rejects(readFile(join(home, 'settings.json')), { code: 'ENOENT' });
});
