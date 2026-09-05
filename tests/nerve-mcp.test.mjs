import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHandler, toolDefinitions } from '../src/nerve-mcp.mjs';

const token = 'test-only-nerve-token-abcdefghijklmnopqrstuvwxyz';
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
async function fixture(t, respond) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const record = { method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null };
    requests.push(record);
    if (respond) return respond(req, res, record);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ accepted: true, method: req.method, path: req.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  return { requests, port, handle: createHandler({ port, token }) };
}

test('MCP handshake, tool discovery and annotations reflect reads versus mutations', async () => {
  const handle = createHandler({ port: 9761, token });
  assert.equal((await handle(rpc('initialize'))).result.protocolVersion, '2024-11-05');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const result = await handle(rpc('tools/list'));
  assert.equal(result.result.tools.length, 10);
  for (const tool of toolDefinitions) assert.equal(tool.annotations.readOnlyHint, ['nerve_read_chat','nerve_status', 'nerve_list_triggers', 'nerve_list_events', 'nerve_get_event'].includes(tool.name));
  assert.equal((await handle(rpc('missing'))).error.code, -32601);
});

test('all tools use loopback authenticated HTTP and encode IDs as one path component', async t => {
  const { handle, requests } = await fixture(t);
  const calls = [
    ['nerve_read_chat', {chatKey:'discord/bot:123',limit:20}, 'GET', '/attention/messages?chatKey=discord%2Fbot%3A123&limit=20'],
    ['nerve_send_chat', {id:'reply-once',chatKey:'discord/bot:123',text:'hello'}, 'POST', '/attention/send'],
    ['nerve_status', {}, 'GET', '/health'],
    ['nerve_list_triggers', {}, 'GET', '/triggers'],
    ['nerve_upsert_trigger', { id: 'check', target: 'codex', everySeconds: 60, check: ['/bin/echo', '{"ready":false}'] }, 'POST', '/triggers'],
    ['nerve_disable_trigger', { id: 'folder/a ?' }, 'DELETE', '/triggers/folder%2Fa%20%3F'],
    ['nerve_list_events', {}, 'GET', '/events'],
    ['nerve_get_event', { id: 'x/y' }, 'GET', '/events/x%2Fy'],
    ['nerve_enqueue_event', { id: 'once', target: 'codex', payload: { prompt: 'test data only' } }, 'POST', '/events'],
    ['nerve_retry_event', { id: 'once' }, 'POST', '/events/once/retry'],
  ];
  for (const [name, args, method, path] of calls) {
    const result = await handle(rpc('tools/call', { name, arguments: args }));
    assert.equal(result.result.isError, false);
    const request = requests.at(-1);
    assert.equal(request.method, method); assert.equal(request.url, path);
    assert.equal(request.authorization, `Bearer ${token}`);
    if (method === 'POST' && !name.includes('retry')) assert.deepEqual(request.body, args);
  }
});

test('rejects ambiguous schedules, arbitrary output commands and malformed checker input before network', async t => {
  const { handle, requests } = await fixture(t);
  for (const args of [
    { id: 'x', target: 'codex' },
    { id: 'x', target: 'codex', daily: '09:00', everySeconds: 30 },
    { id: 'x', target: 'codex', at: '2026-09-05T09:00:00' },
    { id: 'x', target: 'codex', daily: '99:00' },
    { id: 'x', target: 'codex', daily: '09:00', timeZone: 'not-a-zone' },
    { id: 'x', target: 'codex', everySeconds: 1, argv: ['sh', '-c', 'anything'] },
    { id: 'x', target: 'codex', everySeconds: 1, check: 'sh -c anything' },
    { id: 'x', target: 'codex', everySeconds: 1, check: [] },
    { id: '..', target: 'codex', everySeconds: 1 },
  ]) assert.equal((await handle(rpc('tools/call', { name: 'nerve_upsert_trigger', arguments: args }))).error.code, -32602);
  assert.equal(requests.length, 0);
});

test('HTTP failures are tool errors and never forward secrets from diagnostics', async t => {
  const { handle } = await fixture(t, (_, res) => { res.writeHead(409); res.end(token); });
  const response = await handle(rpc('tools/call', { name: 'nerve_enqueue_event', arguments: { id: 'x', target: 'codex', payload: {} } }));
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /409/);
  assert.ok(!JSON.stringify(response).includes(token));
});

test('stdio entrypoint uses private test configuration and emits only JSON RPC', async t => {
  const { port } = await fixture(t);
  const folder = await mkdtemp(join(tmpdir(), 'nerve-mcp-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, 'nerve.json'), JSON.stringify({ port }));
  await writeFile(join(folder, 'secrets.json'), JSON.stringify({ NERVE_TOKEN: token }));
  const child = spawn(process.execPath, ['src/nerve-mcp.mjs'], { env: { ...process.env, NERVE_CONFIG: join(folder, 'nerve.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { stdout += text; });
  child.stderr.on('data', text => { stderr += text; });
  child.stdin.end([JSON.stringify(rpc('initialize')), 'not-json', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), JSON.stringify(rpc('tools/call', { name: 'nerve_status' }, 2)), ''].join('\n'));
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.equal(stderr, '');
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].id, 2); assert.equal(replies[2].result.isError, false);
  assert.ok(!stdout.includes(token));
});
