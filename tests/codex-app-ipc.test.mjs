import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { chmod, mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppIpc } from '../src/codex-app-ipc.mjs';

const threadId = '22222222-2222-4222-8222-222222222222';
const unixSocketTest = process.platform === 'win32'
  ? test.skip
  : test;
const encode = value => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
};

async function fake(t, handler) {
  const codexHome = await mkdtemp(join(tmpdir(), 'rin-app-ipc-'));
  const ipc = join(codexHome, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  const socketPath = join(ipc, 'ipc.sock');
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const value = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        handler({ socket, value, send: response => socket.write(encode(response)) });
      }
    });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, error => error ? reject(error) : resolve()));
  await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of server._connections ? [] : []) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(codexHome, { recursive: true, force: true });
  });
  return { codexHome, socketPath, server };
}

function protocol(handler = () => {}) {
  return ({ socket, value, send }) => {
    handler({ socket, value, send });
    if (value.method === 'initialize') send({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'client-1' } });
    if (value.method === 'thread-owner-discovery') send({ type: 'response', requestId: value.requestId, resultType: 'success', handledByClientId: 'owner-1', result: {} });
    if (value.method === 'thread-follower-steer-turn') send({ type: 'response', requestId: value.requestId, method: value.method, resultType: 'success', result: { result: { turnId: 'turn-1' } } });
    if (value.method === 'thread-follower-start-turn') send({ type: 'response', requestId: value.requestId, method: value.method, resultType: 'success', result: { result: { turn: { id: 'turn-started' } } } });
  };
}

test('validates messages and local images before choosing the IPC transport', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'rin-app-ipc-validation-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const ipc = new CodexAppIpc({ codexHome });

  await assert.rejects(ipc.steer(threadId, { text: '', cwd: '/work' }), /text or image required/);
  await assert.rejects(ipc.steer(threadId, {
    text: '', cwd: '/work', files: [{ path: join(codexHome, 'missing.png'), mimeType: 'image/png' }],
  }), error => error.code === 'ENOENT');

  const largePath = join(codexHome, 'large.png');
  await writeFile(largePath, '');
  await truncate(largePath, 20 * 1024 * 1024 + 1);
  await assert.rejects(ipc.steer(threadId, {
    text: '', cwd: '/work', files: [{ path: largePath, mimeType: 'image/png' }],
  }), /exceeds 20 MiB/);
});

unixSocketTest('steers using the exact local version 1 request shape', async t => {
  const seen = [];
  const f = await fake(t, protocol(({ value }) => seen.push(value)));
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  t.after(() => ipc.stop());
  const result = await ipc.steer(threadId, { text: 'hello', cwd: '/work' });
  assert.equal(result.threadId, threadId);
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.transport, 'app-ipc-steer');
  assert.match(result.messageId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(seen.map(value => [value.method, value.version]), [
    ['initialize', 0], ['thread-owner-discovery', 1], ['thread-follower-steer-turn', 1],
  ]);
  assert.equal(seen[1].params.hostId, 'local');
  assert.equal(seen[2].hostId, undefined);
  assert.equal(seen[2].targetClientId, 'owner-1');
  assert.deepEqual(seen[2].params.input, [{ type: 'text', text: 'hello', text_elements: [] }]);
  assert.deepEqual(seen[2].params.attachments, []);
  assert.equal(seen[2].params.restoreMessage.context.workspaceRoots[0], '/work');
});

unixSocketTest('steers local images with App input, attachment, and restore schemas', async t => {
  const seen = [];
  const f = await fake(t, protocol(({ value }) => seen.push(value)));
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  t.after(() => ipc.stop());
  const imagePath = join(f.codexHome, 'photo.jpg');
  await writeFile(imagePath, 'image');
  await ipc.steer(threadId, {
    text: 'look', cwd: '/work',
    files: [{ path: imagePath, name: 'photo.jpg', mimeType: 'image/jpeg' }],
  });
  const request = seen.find(value => value.method === 'thread-follower-steer-turn');
  assert.deepEqual(request.params.input, [
    { type: 'text', text: 'look', text_elements: [] },
    { type: 'localImage', path: imagePath },
  ]);
  assert.deepEqual(request.params.attachments, [
    { label: 'photo.jpg', path: imagePath, fsPath: imagePath },
  ]);
  const image = request.params.restoreMessage.context.imageAttachments[0];
  assert.match(image.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual({ ...image, id: '<id>' }, {
    id: '<id>', src: imagePath, localPath: imagePath, filename: 'photo.jpg',
  });
  assert.equal(request.params.restoreMessage.context.prompt, 'look');
});

unixSocketTest('accepts an image-only message and starts an idle owner with version 2', async t => {
  const seen = [];
  const f = await fake(t, protocol(({ value }) => seen.push(value)));
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  t.after(() => ipc.stop());
  const imagePath = join(f.codexHome, 'only.png');
  await writeFile(imagePath, 'image');
  const result = await ipc.steer(threadId, {
    text: '', cwd: '/work', start: true,
    files: [{ path: imagePath, mimeType: 'image/png' }],
  });
  assert.equal(result.turnId, 'turn-started');
  assert.equal(result.transport, 'app-ipc-start');
  const request = seen.find(value => value.method === 'thread-follower-start-turn');
  assert.equal(request.version, 2);
  assert.equal(request.targetClientId, 'owner-1');
  assert.deepEqual(request.params, {
    conversationId: threadId,
    turnStart: {
      request: { threadId, input: [{ type: 'localImage', path: imagePath }] },
      context: { inheritThreadSettings: true },
    },
  });
});

unixSocketTest('keeps non-image attachments as local path text and validates images before connecting', async t => {
  const seen = [];
  const f = await fake(t, protocol(({ value }) => seen.push(value)));
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  await assert.rejects(ipc.steer(threadId, { text: '', cwd: '/work' }), /text or image required/);
  await ipc.steer(threadId, {
    text: 'read', cwd: '/work', files: [{ path: '/work/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }],
  });
  const request = seen.find(value => value.method === 'thread-follower-steer-turn');
  assert.equal(request.params.input[0].text, 'read\n\nLocal attachments:\n- a.pdf (application/pdf): /work/a.pdf');
  assert.deepEqual(request.params.restoreMessage.context.imageAttachments, []);
  await assert.rejects(ipc.steer(threadId, {
    text: '', cwd: '/work', files: [{ path: join(f.codexHome, 'missing.png'), mimeType: 'image/png' }],
  }), error => error.code === 'ENOENT');
  const largePath = join(f.codexHome, 'large.png');
  await writeFile(largePath, '');
  await truncate(largePath, 20 * 1024 * 1024 + 1);
  await assert.rejects(ipc.steer(threadId, {
    text: '', cwd: '/work', files: [{ path: largePath, mimeType: 'image/png' }],
  }), /exceeds 20 MiB/);
});

unixSocketTest('malformed start receipt is uncertain', async t => {
  const f = await fake(t, ({ value, send }) => {
    if (value.method === 'initialize') send({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'c' } });
    if (value.method === 'thread-owner-discovery') send({ type: 'response', requestId: value.requestId, resultType: 'success', handledByClientId: 'o' });
    if (value.method === 'thread-follower-start-turn') send({ type: 'response', requestId: value.requestId, method: value.method, resultType: 'success', result: {} });
  });
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  const imagePath = join(f.codexHome, 'only.png');
  await writeFile(imagePath, 'image');
  await assert.rejects(ipc.steer(threadId, {
    text: '', cwd: '/work', start: true,
    files: [{ path: imagePath, mimeType: 'image/png' }],
  }), error => error.code === 'CODEX_APP_IPC_UNCERTAIN');
});

unixSocketTest('handles fragmented frames and unrelated broadcasts', async t => {
  const f = await fake(t, ({ socket, value }) => {
    const responses = [];
    responses.push(encode({ type: 'broadcast', event: 'ignored' }));
    if (value.method === 'initialize') responses.push(encode({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'c' } }));
    if (value.method === 'thread-owner-discovery') responses.push(encode({ type: 'response', requestId: value.requestId, resultType: 'success', handledByClientId: 'o' }));
    if (value.method === 'thread-follower-steer-turn') responses.push(encode({ type: 'response', requestId: value.requestId, method: value.method, resultType: 'success', result: { result: { turnId: 't' } } }));
    const combined = Buffer.concat(responses);
    socket.write(combined.subarray(0, 3));
    setImmediate(() => socket.write(combined.subarray(3)));
  });
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  t.after(() => ipc.stop());
  assert.equal((await ipc.steer(threadId, { text: 'hi', cwd: '/x' })).turnId, 't');
});

unixSocketTest('returns null when socket is missing or owner reports no client', async t => {
  const absent = await mkdtemp(join(tmpdir(), 'rin-app-ipc-absent-'));
  t.after(() => rm(absent, { recursive: true, force: true }));
  const ipcAbsent = new CodexAppIpc({ codexHome: absent });
  assert.equal(await ipcAbsent.steer(threadId, { text: 'hi', cwd: '/x' }), null);

  let steers = 0;
  const f = await fake(t, ({ value, send }) => {
    if (value.method === 'initialize') send({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'c' } });
    if (value.method === 'thread-owner-discovery') send({ type: 'response', requestId: value.requestId, resultType: 'error', error: 'no-client-found' });
    if (value.method === 'thread-follower-steer-turn') steers++;
  });
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  assert.equal(await ipc.steer(threadId, { text: 'hi', cwd: '/x' }), null);
  assert.equal(steers, 0);
});

unixSocketTest('disconnect after steer send is uncertain and payload is redacted', async t => {
  const f = await fake(t, protocol(({ socket, value }) => {
    if (value.method === 'thread-follower-steer-turn') socket.destroy();
  }));
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  await assert.rejects(ipc.steer(threadId, { text: 'private payload', cwd: '/private/path' }), error =>
    error.code === 'CODEX_APP_IPC_UNCERTAIN' && !error.message.includes('private payload') && !error.message.includes('/private/path'));
});

unixSocketTest('timeout and malformed receipt after steer are uncertain', async t => {
  for (const malformed of [false, true]) {
    const f = await fake(t, ({ value, send }) => {
      if (value.method === 'initialize') send({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'c' } });
      if (value.method === 'thread-owner-discovery') send({ type: 'response', requestId: value.requestId, resultType: 'success', handledByClientId: 'o' });
      if (malformed && value.method === 'thread-follower-steer-turn') send({ type: 'response', requestId: value.requestId, method: value.method, resultType: 'success', result: {} });
    });
    const ipc = new CodexAppIpc({ codexHome: f.codexHome, timeoutMs: 30 });
    await assert.rejects(ipc.steer(threadId, { text: 'secret', cwd: '/x' }), error => error.code === 'CODEX_APP_IPC_UNCERTAIN');
  }
});

unixSocketTest('stop cancels active steer, closes sockets, and disables later calls', async t => {
  let peer;
  let steerSeen = false;
  const f = await fake(t, ({ socket, value, send }) => {
    peer = socket;
    if (value.method === 'initialize') send({ type: 'response', requestId: value.requestId, resultType: 'success', result: { clientId: 'c' } });
    if (value.method === 'thread-owner-discovery') send({ type: 'response', requestId: value.requestId, resultType: 'success', handledByClientId: 'o' });
    if (value.method === 'thread-follower-steer-turn') steerSeen = true;
  });
  const ipc = new CodexAppIpc({ codexHome: f.codexHome, timeoutMs: 10_000 });
  const running = assert.rejects(ipc.steer(threadId, { text: 'hi', cwd: '/x' }), /outcome uncertain/);
  while (!peer || !steerSeen) await new Promise(resolve => setImmediate(resolve));
  await ipc.stop();
  await running;
  for (let i = 0; i < 20 && !peer.destroyed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(peer.destroyed, true);
  await assert.rejects(ipc.steer(threadId, { text: 'hi', cwd: '/x' }), /stopped/);
});

unixSocketTest('rejects insecure socket directories without changing permissions', async t => {
  const f = await fake(t, protocol());
  await chmod(join(f.codexHome, 'ipc'), 0o722);
  const ipc = new CodexAppIpc({ codexHome: f.codexHome });
  await assert.rejects(ipc.steer(threadId, { text: 'hi', cwd: '/x' }), /security check/);
});
