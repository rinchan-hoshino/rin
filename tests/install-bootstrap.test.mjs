import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {install, serviceIdForHome} from '../src/install/bootstrap.mjs';

test('bootstrap wrapper is runnable before dist or node_modules exist', async () => {
  const source = await readFile(new URL('../src/install/bootstrap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import .*dist\//m);
  assert.match(source, /await import\('\.\.\/\.\.\/dist\/install\/core\.js'\)/);
});

test('service identity is stable per installation home and isolated between homes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rin-bootstrap-')); t.after(() => rm(root, {recursive:true, force:true}));
  const one = join(root, 'one'), two = join(root, 'two');
  assert.equal(serviceIdForHome(one), serviceIdForHome(one));
  assert.notEqual(serviceIdForHome(one), serviceIdForHome(two));
  assert.match(serviceIdForHome(one), /^com\.rin\.user-[a-f0-9]{12}$/);
});

test('re-running the installer is an idempotent no-op', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rin-bootstrap-existing-')); t.after(() => rm(home, {recursive:true, force:true}));
  await mkdir(home, {recursive:true}); await writeFile(join(home, 'install.json'), '{"schema":1}\n');
  assert.deepEqual(await install({home, binDir:join(home, 'bin')}), {home, binDir:join(home, 'bin'), existing:true});
});
