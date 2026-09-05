import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectChoices, inspectLegacy, disableLegacy, ensureCommandPath, writeLaunchers } from '../src/install/setup.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'rin-setup-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('English setup collects independent product choices and preserves existing AGENTS by default', async () => {
  const answers = ['3', '1,2,1', 'yes', '', 'no'];
  const output = [];
  const choices = await collectChoices(async q => { output.push(q); return answers.shift(); }, s => output.push(s), { hasAgents: true });
  assert.deepEqual(choices, { products: ['codex', 'chatgpt'], recommendations: true, agents: '', history: false });
  assert.match(output.join('\n'), /No recommendation profile/);
  assert.equal(answers.length, 0);
});

test('legacy consent is required before collecting installation changes', async () => {
  let questions = 0;
  await assert.rejects(collectChoices(async () => { questions++; return 'no'; }, () => {}, { legacy: {} }), /cancelled/);
  assert.equal(questions, 1);
});

test('legacy detection identifies its own launcher and leaves unrelated commands alone', async t => {
  const userHome = await temporary(t), bin = join(userHome, '.local/bin'), other = join(userHome, 'other');
  await mkdir(join(userHome, '.rin'), { recursive: true }); await mkdir(bin, { recursive: true }); await mkdir(other);
  await writeFile(join(userHome, '.rin/installer.json'), JSON.stringify({ service: { kind: 'launchd', label: 'com.rin.daemon.example' } }));
  await writeFile(join(bin, 'rin'), `#!/bin/sh\nexec '${join(userHome, '.rin/app/current/dist/app/rin/main.js')}' "$@"\n`);
  await writeFile(join(other, 'rin'), '#!/bin/sh\nprintf unrelated\n');
  const result = await inspectLegacy({ userHome, env: { PATH: [bin, other].join(process.platform === 'win32' ? ';' : ':') } });
  assert.deepEqual(result.cli, [join(bin, 'rin')]);
  const calls = [];
  await disableLegacy(result, { platform: 'darwin', exec: async (command, args) => { calls.push([command, args]); return { code: args[0] === 'print' ? 113 : 0 }; } });
  assert.equal(calls[0][1][0], 'disable');
  assert.equal(calls.some(([, args]) => args[0] === 'bootout'), false);
  assert.match(await readFile(join(bin, 'rin.pi-disabled'), 'utf8'), /app[\\/]current/);
  assert.match(await readFile(join(other, 'rin'), 'utf8'), /unrelated/);
});

test('a legacy backup collision aborts before any service action', async t => {
  const dir = await temporary(t), file = join(dir, 'rin');
  await writeFile(`${file}.pi-disabled`, 'previous');
  let calls = 0;
  await assert.rejects(disableLegacy({ cli: [file], service: { kind: 'launchd', label: 'com.rin.daemon.example' } }, { exec: async () => { calls++; } }), /already exists/);
  assert.equal(calls, 0);
});

test('command path setup is idempotent and preserves a shell profile', async t => {
  const userHome = await temporary(t), file = join(userHome, '.zshrc');
  await writeFile(file, 'export EDITOR=vi\n');
  const bin = join(userHome, "Rin's bin"), options = { userHome, platform: 'darwin', env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } };
  await ensureCommandPath(bin, options); const once = await readFile(file, 'utf8');
  await ensureCommandPath(bin, options);
  assert.equal(await readFile(file, 'utf8'), once);
  assert.ok(once.startsWith('export EDITOR=vi\n'));
  assert.match(once, /Rin'\\''s bin/);
});

test('launcher publication never replaces an unrelated executable', async t => {
  const home = await temporary(t), binDir = join(home, 'bin'); await mkdir(binDir);
  const name = process.platform === 'win32' ? 'rin.cmd' : 'rin';
  await writeFile(join(binDir, name), 'unrelated');
  await assert.rejects(writeLaunchers(home, { binDir }), /unrelated launcher/);
  assert.equal(await readFile(join(binDir, name), 'utf8'), 'unrelated');
});
