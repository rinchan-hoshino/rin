import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareSetupDependencies} from '../src/install/bootstrap.mjs';

async function root(t, installed) {
  const path = await mkdtemp(join(tmpdir(), 'rin-setup-bootstrap-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  await writeFile(join(path, 'package.json'), JSON.stringify({dependencies: {'@clack/prompts': '0.10.1'}}));
  if (installed) {
    await mkdir(join(path, 'node_modules/@clack/prompts'), {recursive: true});
    await writeFile(join(path, 'node_modules/@clack/prompts/package.json'), JSON.stringify({version: installed}));
  }
  return path;
}

test('a clean installer root prepares Clack before setup import', async t => {
  const calls = [], path = await root(t);
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, process.execPath);
  assert.match(args[0], /npm-cli\.js$/);
  assert.deepEqual(args.slice(1), ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.deepEqual(options, {cwd: path});
});

test('a matching installed Clack version skips npm preparation', async t => {
  const calls = [], path = await root(t, '0.10.1');
  await prepareSetupDependencies(path, {exec: async (...call) => calls.push(call)});
  assert.deepEqual(calls, []);
});
