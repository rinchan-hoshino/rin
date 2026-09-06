import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import {spawn} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import {pathToFileURL} from 'node:url';
import { appendAgentsInstructions, RIN_SUBAGENT_INSTRUCTIONS, collectChoices, inspectLegacy, disableLegacy, ensureCommandPath, writeLaunchers } from '../src/install/setup.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'rin-setup-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function runEntry(args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], ...options});
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => accept({code, stdout, stderr}));
  });
}

function uiFixture(answers) {
  const events = [], cancelled = Symbol('cancelled');
  const next = kind => async input => { events.push([kind, input]); return answers.shift(); };
  return {
    events, cancelled,
    intro: value => events.push(['intro', value]), note: (body, title) => events.push(['note', title, body]), outro: value => events.push(['outro', value]), cancel: value => events.push(['cancel', value]),
    multiselect: next('multiselect'), confirm: next('confirm'), select: next('select'), text: next('text'),
    isCancel: value => value === cancelled,
    log: {info: value => events.push(['info', value]), error: value => events.push(['error', value])},
  };
}

test('Clack setup collects independent product choices and preserves existing AGENTS by default', async () => {
  const ui = uiFixture([['codex', 'chatgpt'], true, false, false, true]);
  const choices = await collectChoices({hasAgents: true, ui});
  assert.deepEqual(choices, {products: ['codex', 'chatgpt'], recommendations: true, agents: '', subagentGuidance: false});
  const notes = ui.events.filter(([kind]) => kind === 'note').map(([, , body]) => body).join('\n');
  assert.match(notes, /full filesystem access/);
  assert.match(notes, /approval_policy=never/);
  assert.match(notes, /120,000 tokens/);
  assert.match(notes, /Original-session search: included \(FFF MCP\)/);
  assert.equal(ui.events.some(([kind, options]) => kind === 'confirm' && /FFF/.test(options.message)), false);
});

test('legacy decline and explicit final decline return null without an installation choice', async () => {
  const legacyUI = uiFixture([false]);
  assert.equal(await collectChoices({legacy: {}, ui: legacyUI}), null);
  assert.equal(legacyUI.events.filter(([kind]) => kind === 'multiselect').length, 0);

  const finalUI = uiFixture([[], false, 'skip', false, false]);
  assert.equal(await collectChoices({ui: finalUI}), null);
  assert.match(finalUI.events.at(-1)[1], /Finished without installing Rin/);
});

test('a Clack cancellation is reported with INSTALL_CANCELLED', async () => {
  const ui = uiFixture([]);
  ui.multiselect = async () => ui.cancelled;
  await assert.rejects(collectChoices({ui}), error => error.code === 'INSTALL_CANCELLED');
  assert.deepEqual(ui.events.at(-1), ['cancel', 'Installation cancelled.']);
});

test('empty product selection is accepted and manual instructions preserve existing AGENTS text', async t => {
  const ui = uiFixture([[], false, 'text', 'Use short answers.', false, true]);
  const choices = await collectChoices({ui});
  assert.deepEqual(choices.products, []);
  const file = join(await temporary(t), 'AGENTS.md');
  await writeFile(file, 'Existing instructions.\n');
  await appendAgentsInstructions(file, choices);
  assert.equal(await readFile(file, 'utf8'), 'Existing instructions.\n\nUse short answers.\n');
});

test('blank manual instructions use an empty Clack default instead of prompt placeholder text', async () => {
  const ui = uiFixture([[], false, 'text', '', false, true]);
  const choices = await collectChoices({ui});
  assert.equal(choices.agents, '');
  const [, options] = ui.events.find(([kind]) => kind === 'text');
  assert.equal(options.defaultValue, '');
  assert.equal('placeholder' in options, false);
});

test('file instructions retry after an unreadable path and preserve existing AGENTS text', async t => {
  const dir = await temporary(t), source = join(dir, 'instructions.md'), agents = join(dir, 'AGENTS.md');
  await writeFile(source, 'Prefer concrete examples.\n');
  await writeFile(agents, 'Existing instructions.\n');
  const ui = uiFixture([[], false, 'file', join(dir, 'missing.md'), source, false, true]);
  const choices = await collectChoices({ui});
  assert.equal(choices.agents, 'Prefer concrete examples.\n');
  assert.equal(ui.events.filter(([kind]) => kind === 'error').length, 1);
  await appendAgentsInstructions(agents, choices);
  assert.equal(await readFile(agents, 'utf8'), 'Existing instructions.\n\nPrefer concrete examples.\n\n');
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

test('AGENTS append preserves existing bytes, orders guidance last and avoids exact duplicates', async t => {
  const dir = await temporary(t), file = join(dir, 'AGENTS.md');
  const original = 'Keep these spaces  \n\n';
  await writeFile(file, original);
  assert.equal(await appendAgentsInstructions(file), false);
  assert.equal(await readFile(file, 'utf8'), original);
  await appendAgentsInstructions(file, {agents: 'My added instructions', subagentGuidance: true});
  const once = await readFile(file, 'utf8');
  assert.ok(once.startsWith(original));
  assert.ok(once.indexOf('My added instructions') < once.indexOf(RIN_SUBAGENT_INSTRUCTIONS));
  assert.ok(once.endsWith(RIN_SUBAGENT_INSTRUCTIONS + '\n'));
  assert.equal(await appendAgentsInstructions(file, {subagentGuidance: true}), false);
  assert.equal(await readFile(file, 'utf8'), once);
});

test('declining all AGENTS additions creates no file; guidance alone can create one', async t => {
  const file = join(await temporary(t), 'nested', 'AGENTS.md');
  assert.equal(await appendAgentsInstructions(file), false);
  await assert.rejects(readFile(file), {code: 'ENOENT'});
  assert.equal(await appendAgentsInstructions(file, {subagentGuidance: true}), true);
  assert.equal(await readFile(file, 'utf8'), 'Make active use of subagents: use Astra for work that can run in parallel, Terra for relatively independent, simple tasks, and Luna for purely execution-oriented tasks.\n');
});

test('setup CLI reports the non-interactive preflight failure once', async () => {
  const result = await runEntry([resolve('src/install/setup.mjs')]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Run the installer in an interactive terminal\n');
});

test('setup CLI reports an existing installation before starting prompts', async t => {
  const home = await temporary(t), entry = resolve('src/install/setup.mjs');
  await writeFile(join(home, 'install.json'), '{}');
  const source = `Object.defineProperty(process.stdin, 'isTTY', {value: true});process.argv[1]=${JSON.stringify(entry)};await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  const result = await runEntry(['--input-type=module', '--eval', source], {env: {...process.env, RIN_HOME: home}});
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Rin is already installed here. Use rin update.\n');
});
