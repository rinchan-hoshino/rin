import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexExec } from '../src/codex-exec.mjs';
const id = '22222222-2222-4222-8222-222222222222';
const emit = value => `console.log(${JSON.stringify(JSON.stringify(value))});`;
const start = emit({ type: 'thread.started', thread_id: id });
const complete = emit({ type: 'turn.completed', usage: {} });
async function fixture(t, source, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-exec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'peer.mjs'), `process.stdin.resume(); ${source}`);
  return { dir, exec: new CodexExec({ command: [process.execPath, join(dir, 'peer.mjs')], cwd: dir, codexHome: dir, ...options }) };
}

test('exec resume uses stdin, preserves permissions, and returns only last assistant text', async t => {
  const old = process.env.NERVE_SECRET;
  process.env.NERVE_SECRET = 'do not inherit';
  t.after(() => { if (old === undefined) delete process.env.NERVE_SECRET; else process.env.NERVE_SECRET = old; });
  const f = await fixture(t, `import {writeFileSync} from 'node:fs';
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
writeFileSync('call.json',JSON.stringify({args:process.argv.slice(2), input, nerve:process.env.NERVE_SECRET,home:process.env.CODEX_HOME}));
${start}
${emit({ type: 'item.completed', item: { type: 'error', message: 'nonfatal MCP warning' } })}
${emit({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'tool secret' } })}
${emit({ type: 'item.completed', item: { type: 'agent_message', text: 'earlier queued answer' } })}
${emit({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } })}
${complete}
});`);
  assert.deepEqual(await f.exec.run(id, { text: '$(literal)中文' }), { threadId: id, text: 'final answer', completed: true });
  const call = JSON.parse(await readFile(join(f.dir, 'call.json'), 'utf8'));
  assert.deepEqual(call.args, ['exec', 'resume', '--json', '--skip-git-repo-check', id, '-']);
  assert.equal(call.input, '$(literal)中文');
  assert.equal(call.nerve, undefined);
  assert.equal(call.home, f.dir);
});

for (const [name, source] of [
  ['no completion', start],
  ['later incomplete turn', start + complete + emit({ type: 'turn.started' })],
  ['wrong thread', emit({ type: 'thread.started', thread_id: 'different' }) + complete],
  ['failed turn', start + emit({ type: 'turn.failed', error: { message: 'private diagnostic' } })],
  ['top-level error', start + emit({ type: 'error', message: 'private diagnostic' })],
  ['malformed output', `console.log('not json');`],
  ['nonzero exit', start + complete + `process.exitCode = 1;`],
  ['oversized line', `console.log('x'.repeat(600000));`],
  ['oversized total output', `for(let i=0;i<200;i++) console.log(JSON.stringify({type:'item.updated',ignored:'x'.repeat(60000)}));`],
]) test(`exec ${name} remains uncertain and never echoes diagnostics`, async t => {
  const f = await fixture(t, source + `console.error('private diagnostic');`);
  await assert.rejects(f.exec.run(id, { text: 'hello' }), error => error.code === 'CODEX_EXEC_UNCERTAIN' && !error.message.includes('private diagnostic'));
});

test('timeout terminates a running invocation and stop prevents new runs', async t => {
  const f = await fixture(t, `setInterval(() => {}, 1000);`, { timeoutMs: 40 });
  await assert.rejects(f.exec.run(id, { text: 'hello' }), /timed out; outcome uncertain/);
  assert.equal(f.exec.children.size, 0);
  await f.exec.stop();
  await assert.rejects(f.exec.run(id, { text: 'hello' }), /stopped/);
});

test('stop terminates active invocation and its child process group', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const descendant = spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync('descendant.pid', String(descendant.pid)); setInterval(()=>{},1000);`);
  const running = assert.rejects(f.exec.run(id, { text: 'hello' }), /stopped; outcome uncertain/);
  let pid;
  for (let i = 0; i < 50; i++) {
    try { pid = Number(await readFile(join(f.dir, 'descendant.pid'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  await f.exec.stop();
  await running;
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('descendant process survived stop');
});
