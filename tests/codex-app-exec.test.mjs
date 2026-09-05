import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppExec } from '../src/codex-app-exec.mjs';
import { Nerve, Store, validateConfig } from '../src/nerve.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function setup(queue, timeoutMs = 1000) {
  const calls = [];
  let emit;
  const runner = new CodexAppExec({ timeoutMs, bridgeFactory: options => {
    assert.equal(options.appSteering, true);
    assert.equal(options.appWake, true);
    emit = options.onEvent;
    return {
      start: async () => calls.push('start'),
      watch: () => { calls.push('watch'); return () => calls.push('unwatch'); },
      queue: async (...args) => { calls.push('queue'); return queue(emit, ...args); },
      stop: async () => calls.push('stop'),
    };
  }});
  return { runner, calls, emit: value => emit({ threadId, ...value }) };
}
const receipt = { transport: 'app-ipc-start', turnId: 'target-turn' };

test('watch precedes submission and fast completion is matched to receipt', async () => {
  const { runner, calls } = setup(async emit => {
    emit({ threadId, turnId: 'unrelated', type: 'failed' });
    emit({ threadId, turnId: receipt.turnId, type: 'text', phase: 'final', text: 'done' });
    emit({ threadId, turnId: receipt.turnId, type: 'completed' });
    return receipt;
  });
  assert.deepEqual(await runner.run(threadId, { text: 'event' }), { threadId, turnId: receipt.turnId, completed: true, text: 'done' });
  assert.deepEqual(calls, ['start', 'watch', 'queue', 'unwatch']);
  await runner.stop();
});

test('admission and unrelated completion cannot finish the event', async () => {
  const fixture = setup(async () => receipt);
  let done = false;
  const pending = fixture.runner.run(threadId, { text: 'event' }).then(result => { done = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  fixture.emit({ turnId: 'unrelated', type: 'completed' });
  fixture.emit({ turnId: receipt.turnId, type: 'text', phase: 'question', text: 'ask' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  fixture.emit({ turnId: receipt.turnId, type: 'completed' });
  assert.equal((await pending).text, '');
  await fixture.runner.stop();
});

for (const kind of ['failed', 'observerError', 'timeout', 'queued', 'queueError', 'stop']) {
  test(`${kind} stays uncertain and releases observer without replay`, async () => {
    const fixture = setup(async () => {
      if (kind === 'queueError') throw new Error('unknown delivery');
      return kind === 'queued' ? { queued: true } : receipt;
    }, kind === 'timeout' ? 20 : 1000);
    const pending = fixture.runner.run(threadId, { text: 'event' });
    const checked = assert.rejects(pending, error => error.code === 'CODEX_APP_UNCERTAIN');
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'failed' || kind === 'observerError') fixture.emit({ turnId: receipt.turnId, type: kind });
    if (kind === 'stop') await fixture.runner.stop();
    await checked;
    assert.equal(fixture.calls.filter(value => value === 'queue').length, 1);
    assert.equal(fixture.calls.filter(value => value === 'unwatch').length, 1);
    await fixture.runner.stop();
  });
}

test('Nerve app target preserves one session, prompt and no automatic retry', async () => {
  const target = { type: 'codex-app', threadId };
  assert.throws(() => validateConfig({ targets: { a: target, b: { type: 'codex', threadId } } }), /Only one/);
  assert.throws(() => validateConfig({ targets: { a: { ...target, idempotent: true } } }), /retries/);
  const store = new Store(':memory:');
  const nerve = new Nerve({ targets: { main: target } }, store);
  let calls = 0;
  nerve.codex = { run: async (id, input) => {
    assert.equal(id, threadId);
    assert.equal(input.text, 'External event e\n\nprompt content');
    calls++;
    throw new Error('uncertain');
  }, stop: async () => {} };
  store.enqueue('e', 'main', { prompt: 'prompt content' });
  await nerve.tick();
  await nerve.tick();
  await Promise.all([...nerve.running]);
  assert.equal(calls, 1);
  assert.equal(store.event('e').state, 'uncertain');
  await nerve.close();
  store.close();
});

test('second owner event is submitted before first completion and shares its observer and turn', async () => {
  const submitted = [];
  const fixture = setup(async (_emit, _threadId, input) => {
    submitted.push(input.text);
    return { ...receipt, transport: submitted.length === 1 ? 'app-ipc-start' : 'app-ipc-steer' };
  });
  const first = fixture.runner.run(threadId, { text: 'first' });
  await new Promise(resolve => setImmediate(resolve));
  const second = fixture.runner.run(threadId, { text: 'owner interruption' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ['first', 'owner interruption']);
  assert.equal(fixture.calls.filter(value => value === 'watch').length, 1);
  fixture.emit({ turnId: receipt.turnId, type: 'completed' });
  assert.equal((await first).turnId, (await second).turnId);
  assert.equal(fixture.calls.filter(value => value === 'unwatch').length, 1);
  await fixture.runner.stop();
});

test('only submission is serialized, failures do not replay and in-flight inputs are bounded', async () => {
  let release;
  let count = 0;
  const fixture = setup(async () => {
    count++;
    if (count === 1) await new Promise(resolve => { release = resolve; });
    return receipt;
  });
  const pending = Array.from({ length: 16 }, (_, index) => fixture.runner.run(threadId, { text: `event ${index}` }));
  const checks = pending.map(promise => assert.rejects(promise, /uncertain/));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 1);
  await assert.rejects(fixture.runner.run(threadId, { text: 'overflow' }), /limit/);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 16);
  await fixture.runner.stop();
  await Promise.all(checks);
});

test('Nerve App admissions overlap completion with a bound and command targets wait', async () => {
  const store = new Store(':memory:');
  const nerve = new Nerve({ targets: { main: { type: 'codex-app', threadId }, command: { type: 'command', argv: ['false'] } } }, store);
  const completes = [];
  nerve.codex = { run: async () => new Promise(resolve => completes.push(resolve)), stop: async () => {} };
  for (let i=0;i<18;i++) store.enqueue(`e${i}`, 'main', { prompt: 'owner' }, i);
  await nerve.tick();
  store.enqueue('command', 'command', {}, -1);
  for (let i=1;i<18;i++) await nerve.tick();
  assert.equal(store.event('command').state, 'pending');
  assert.equal(nerve.running.size, 16);
  assert.equal(completes.length, 16);
  assert.equal(store.event('e16').state, 'pending');
  completes.forEach(resolve => resolve({ completed: true, threadId, turnId: 'shared' }));
  await Promise.all([...nerve.running]);
  assert.equal(nerve.busy, false);
  assert.equal(store.event('e0').state, 'done');
  await nerve.close();
  store.close();
});
