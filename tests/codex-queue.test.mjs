import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexQueue } from '../src/codex-queue.mjs';

async function peer(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-native-queue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'peer.mjs');
  await writeFile(path, source);
  return { dir, command: [process.execPath, path] };
}

test('native queue strips Nerve and legacy Pi secrets while retaining Codex home and literal argv', async t => {
  const f = await peer(t, `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.QUEUE_TEST_LOG, JSON.stringify({env: process.env, args: process.argv.slice(2)}));
console.log('Queued message 22222222-2222-4222-8222-222222222222');`);
  const settings = { NERVE_API_TOKEN: 'private', NERVE_PORT: '9999', RIN_DIR: '/legacy', PI_CODING_AGENT_DIR: '/old-pi', QUEUE_TEST_LOG: join(f.dir, 'log.json') };
  for (const [key, value] of Object.entries(settings)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const queue = new CodexQueue({ command: f.command, codexHome: f.dir });
  await queue.start();
  t.after(() => queue.stop());
  const result = await queue.queue('existing-thread', { text: '$(literal); `still literal`' });
  assert.equal(result.messageId, '22222222-2222-4222-8222-222222222222');
  const logged = JSON.parse(await readFile(settings.QUEUE_TEST_LOG, 'utf8'));
  for (const key of Object.keys(settings).filter(key => key !== 'QUEUE_TEST_LOG')) assert.equal(logged.env[key], undefined);
  assert.equal(logged.env.CODEX_HOME, f.dir);
  assert.deepEqual(logged.args, ['queue', '--thread', 'existing-thread', '--message', '$(literal); `still literal`']);
});

test('successful subprocess without queue receipt remains uncertain', async t => {
  const f = await peer(t, `console.log('done');`);
  const queue = new CodexQueue({ command: f.command });
  await queue.start();
  t.after(() => queue.stop());
  await assert.rejects(queue.queue('existing-thread', { text: 'hello' }), /no receipt; outcome uncertain/);
});

test('timeout rejects as uncertain and stop reaps queue subprocesses', async t => {
  const f = await peer(t, `setInterval(() => {}, 1000);`);
  const queue = new CodexQueue({ command: f.command, queueTimeoutMs: 50 });
  await queue.start();
  await assert.rejects(queue.queue('existing-thread', { text: 'hello' }), /timed out; outcome uncertain/);
  await queue.stop();
  assert.equal(queue.children.size, 0);
  await assert.rejects(queue.queue('existing-thread', { text: 'hello' }), /not started/);
});

test('stopping an active queue cancels its child and disables new submissions', async t => {
  const f = await peer(t, `setInterval(() => {}, 1000);`);
  const queue = new CodexQueue({ command: f.command });
  await queue.start();
  const rejected = assert.rejects(queue.queue('existing-thread', { text: 'hello' }), /Codex queue failed/);
  assert.equal(queue.children.size, 1);
  await queue.stop();
  await rejected;
  assert.equal(queue.children.size, 0);
});

test('images are explicitly rejected before spawning unsupported queue CLI', async t => {
  const f=await peer(t,"throw Error('must not spawn');");const queue=new CodexQueue({command:f.command,codexHome:f.dir});await queue.start();t.after(()=>queue.stop());
  await assert.rejects(queue.queue('thread',{text:'photo',files:[{path:'/tmp/photo.png',mimeType:'image/png'}]}),{code:'CODEX_INPUT_UNSUPPORTED'});
  assert.equal(queue.children.size,0);
});
