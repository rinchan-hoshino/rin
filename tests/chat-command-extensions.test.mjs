import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCommandExtensions } from '../src/chat/command-extensions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rin-command-extensions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function logger() {
  const calls = [];
  return { calls, log: { warn: (...args) => calls.push(args) } };
}

test('missing directory is created privately and loads as empty', async t => {
  const root = await fixture(t), directory = join(root, 'new');
  assert.deepEqual(await loadCommandExtensions({ directory }), []);
  const { mode } = await import('node:fs/promises').then(fs => fs.stat(directory));
  assert.equal(mode & 0o077, 0);
});

test('valid modules load in filename order and expose only protocol fields', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'b.mjs'), `export default {name:'beta',description:'Beta',privateOnly:true,extra:'hidden',run:async input=>input.args}`);
  await writeFile(join(directory, 'a.mjs'), `export default {name:'alpha_1',description:'Alpha',argument:'VALUE',extra:'hidden',run:async input=>input.message}`);
  await writeFile(join(directory, 'ignored.txt'), `not javascript`);
  await mkdir(join(directory, 'nested.mjs'));
  const result = await loadCommandExtensions({ directory });
  assert.deepEqual(result.map(item => item.name), ['alpha_1', 'beta']);
  assert.deepEqual(Object.keys(result[0]), ['name', 'description', 'argument', 'run']);
  assert.deepEqual(Object.keys(result[1]), ['name', 'description', 'privateOnly', 'run']);
  assert.equal(await result[0].run({ args: 'x', message: 'm', dataDir: directory }), 'm');
});

test('imports and invalid descriptors fail closed with fixed warnings', async t => {
  const directory = await fixture(t), { calls, log } = logger();
  const files = {
    'a.mjs': `throw new Error('secret-token-and-path')`,
    'b.mjs': `export default {name:'UPPER',description:'bad',run(){}}`,
    'c.mjs': `export default {name:'missing_run',description:'bad'}`,
    'd.mjs': `export default {name:'too_long_name_123',description:'bad',run(){}}`,
    'e.mjs': `export default {name:'arg',description:'ok',argument:'',run(){}}`,
    'f.mjs': `export default {name:'private',description:'ok',privateOnly:'yes',run(){}}`,
  };
  await Promise.all(Object.entries(files).map(([name, source]) => writeFile(join(directory, name), source)));
  assert.deepEqual(await loadCommandExtensions({ directory, log }), []);
  assert.equal(calls.length, Object.keys(files).length);
  assert.deepEqual([...new Set(calls.flat())], ['Command extension ignored.']);
});

test('reserved names and every member of duplicate extension names are rejected while other modules remain', async t => {
  const directory = await fixture(t), { calls, log } = logger();
  await writeFile(join(directory, 'a.mjs'), `export default {name:'same',description:'First',run(){}}`);
  await writeFile(join(directory, 'b.mjs'), `export default {name:'same',description:'Second',run(){}}`);
  await writeFile(join(directory, 'c.mjs'), `export default {name:'usage',description:'Reserved',run(){}}`);
  await writeFile(join(directory, 'd.mjs'), `export default {name:'kept',description:'Valid',run(){}}`);
  const result = await loadCommandExtensions({ directory, reservedNames: ['usage'], log });
  assert.deepEqual(result.map(item => item.name), ['kept']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.length === 1 && call[0] === 'Command extension ignored.'));
});
