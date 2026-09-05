import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} required`);
  return value.trim();
}

async function messageParts(text, files) {
  const originalMessage = typeof text === 'string' ? text.trim() : '';
  if (!Array.isArray(files)) throw new Error('files must be an array');
  const normalized = files.map((file, index) => {
    if (!file || typeof file !== 'object') throw new Error(`files[${index}] must be an object`);
    const path = requiredText(file.path, `files[${index}].path`);
    const mimeType = typeof file.mimeType === 'string' ? file.mimeType.trim().toLowerCase() : '';
    const filename = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : basename(path);
    return { path, mimeType, filename };
  });
  const imageFiles = normalized.filter(file => file.mimeType.startsWith('image/'));
  const otherFiles = normalized.filter(file => !file.mimeType.startsWith('image/'));
  const images = await Promise.all(imageFiles.map(async file => {
    const metadata = await stat(file.path);
    if (!metadata.isFile()) throw new Error(`image is not a regular file: ${file.path}`);
    if (metadata.size > MAX_IMAGE_BYTES) throw new Error(`image exceeds 20 MiB limit: ${file.path}`);
    return { id: randomUUID(), src: file.path, localPath: file.path, filename: file.filename };
  }));
  const attachmentText = otherFiles.length
    ? `Local attachments:\n${otherFiles.map(file => `- ${file.filename}${file.mimeType ? ` (${file.mimeType})` : ''}: ${file.path}`).join('\n')}`
    : '';
  const message = [originalMessage, attachmentText].filter(Boolean).join('\n\n');
  if (!message && images.length === 0) throw new Error('text or image required');
  return {
    message,
    images,
    input: [
      ...(message ? [{ type: 'text', text: message, text_elements: [] }] : []),
      ...images.map(image => ({ type: 'localImage', path: image.localPath })),
    ],
    attachments: images.map(image => ({ label: image.filename, path: image.localPath, fsPath: image.localPath })),
  };
}

function uncertain(reason) {
  const error = new Error(`Codex App IPC ${reason}; outcome uncertain`);
  error.code = 'CODEX_APP_IPC_UNCERTAIN';
  return error;
}

function ordinary(reason) {
  const error = new Error(`Codex App IPC ${reason}`);
  error.code = 'CODEX_APP_IPC_ERROR';
  return error;
}

async function verifySocket(socketPath) {
  const directory = await lstat(join(socketPath, '..'));
  const socket = await lstat(socketPath);
  const uid = process.getuid?.();
  if (uid === undefined) throw ordinary('cannot verify socket owner');
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022)) {
    throw ordinary('socket directory failed security check');
  }
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o022)) {
    throw ordinary('socket failed security check');
  }
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length > MAX_FRAME_BYTES) throw ordinary('request exceeds frame limit');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Send text to the active Codex desktop owner over its private local IPC socket. */
export class CodexAppIpc {
  constructor({ codexHome, timeoutMs = 30_000 } = {}) {
    this.codexHome = requiredText(codexHome, 'codexHome');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('positive timeoutMs required');
    this.timeoutMs = timeoutMs;
    this.operations = new Set();
    this.stopped = false;
  }

  async steer(threadId, { text, cwd, files = [], start = false } = {}) {
    if (this.stopped) throw new Error('CodexAppIpc stopped');
    const conversationId = requiredText(threadId, 'threadId');
    const workingDirectory = requiredText(cwd, 'cwd');
    const { message, images, input, attachments } = await messageParts(text, files);
    if (typeof start !== 'boolean') throw new Error('start must be a boolean');
    if (process.platform === 'win32') return null;

    const socketPath = join(this.codexHome, 'ipc', 'ipc.sock');
    try {
      await verifySocket(socketPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw error;
    }
    if (this.stopped) throw new Error('CodexAppIpc stopped');

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const pending = new Map();
      let buffer = Buffer.alloc(0);
      let connected = false;
      let mutationSent = false;
      let settled = false;
      let sourceClientId = 'initializing-client';
      let ownerId;
      const connectTimer = setTimeout(() => {
        if (!connected) fail(ordinary('connect timed out'));
      }, this.timeoutMs);

      const operation = {
        socket,
        cancel: () => fail(mutationSent ? uncertain('stopped') : ordinary('stopped')),
      };
      this.operations.add(operation);

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(error || ordinary('connection closed'));
        }
        pending.clear();
        this.operations.delete(operation);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const fail = error => finish(error);
      const transportFailure = reason => fail(mutationSent ? uncertain(reason) : ordinary(reason));

      const request = (method, params, { version, targetClientId, mutation = false }) => new Promise((requestResolve, requestReject) => {
        if (settled) return requestReject(mutationSent || mutation ? uncertain('connection closed') : ordinary('connection closed'));
        const requestId = randomUUID();
        const value = {
          type: 'request', requestId, sourceClientId, version, method, params,
          timeoutMs: this.timeoutMs,
          ...(targetClientId ? { targetClientId } : {}),
        };
        let encoded;
        try { encoded = frame(value); } catch (error) { requestReject(error); return; }
        const timer = setTimeout(() => {
          pending.delete(requestId);
          requestReject(mutationSent || mutation ? uncertain(`${method} timed out`) : ordinary(`${method} timed out`));
        }, this.timeoutMs);
        pending.set(requestId, { resolve: requestResolve, reject: requestReject, timer });
        if (mutation) mutationSent = true;
        socket.write(encoded, error => {
          if (!error) return;
          const entry = pending.get(requestId);
          if (!entry) return;
          pending.delete(requestId);
          clearTimeout(timer);
          requestReject(mutationSent ? uncertain('write failed') : ordinary('write failed'));
        });
      });

      socket.on('data', chunk => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > MAX_FRAME_BYTES) return transportFailure('frame limit exceeded');
          if (buffer.length < length + 4) return;
          const payload = buffer.subarray(4, length + 4);
          buffer = buffer.subarray(length + 4);
          let value;
          try { value = JSON.parse(payload.toString('utf8')); }
          catch { return transportFailure('received malformed frame'); }
          if (value?.type !== 'response' || typeof value.requestId !== 'string') continue;
          const entry = pending.get(value.requestId);
          if (!entry) continue;
          pending.delete(value.requestId);
          clearTimeout(entry.timer);
          entry.resolve(value);
        }
      });
      socket.once('error', error => {
        if (settled) return;
        if (!connected && !mutationSent && ['ENOENT', 'ECONNREFUSED'].includes(error?.code)) return finish(null, null);
        transportFailure(connected ? 'connection failed' : 'could not connect');
      });
      socket.once('close', () => {
        if (!settled) transportFailure('connection closed');
      });
      socket.once('connect', async () => {
        connected = true;
        clearTimeout(connectTimer);
        try {
          const initialized = await request('initialize', { clientType: 'rin-chat-bridge' }, { version: 0 });
          if (initialized?.resultType !== 'success' || typeof initialized?.result?.clientId !== 'string' || !initialized.result.clientId) {
            throw ordinary('initialize failed');
          }
          sourceClientId = initialized.result.clientId;
          const owner = await request('thread-owner-discovery', { hostId: 'local', conversationId }, { version: 1 });
          if (owner?.resultType === 'no-client-found' || (owner?.resultType === 'error' && owner?.error === 'no-client-found')) {
            return finish(null, null);
          }
          if (owner?.resultType !== 'success' || typeof owner.handledByClientId !== 'string' || !owner.handledByClientId) {
            throw ordinary('owner discovery failed');
          }
          ownerId = owner.handledByClientId;
          const messageId = randomUUID();
          const method = start ? 'thread-follower-start-turn' : 'thread-follower-steer-turn';
          const params = start ? {
            conversationId,
            turnStart: {
              request: { threadId: conversationId, input },
              context: { inheritThreadSettings: true },
            },
          } : {
            conversationId,
            input,
            clientUserMessageId: messageId,
            serviceTier: null,
            attachments,
            restoreMessage: {
              id: messageId, text: message, cwd: workingDirectory, createdAt: Date.now(),
              context: {
                prompt: message, addedFiles: [], fileAttachments: [], ideContext: null,
                imageAttachments: images, workspaceRoots: [workingDirectory],
              },
            },
          };
          const response = await request(method, params, {
            version: start ? 2 : 1, targetClientId: ownerId, mutation: true,
          });
          const turnId = start ? response?.result?.result?.turn?.id : response?.result?.result?.turnId;
          if (response?.resultType !== 'success' || response?.method !== method || typeof turnId !== 'string' || !turnId) {
            throw uncertain(`${start ? 'start' : 'steer'} returned no valid receipt`);
          }
          finish(null, {
            threadId: conversationId, messageId, turnId,
            transport: start ? 'app-ipc-start' : 'app-ipc-steer',
          });
        } catch (error) {
          fail(mutationSent && error?.code !== 'CODEX_APP_IPC_UNCERTAIN'
            ? uncertain('steer failed') : error);
        }
      });
    });
  }

  async stop() {
    this.stopped = true;
    const operations = [...this.operations];
    for (const operation of operations) operation.cancel();
    for (const operation of operations) operation.socket.destroy();
  }
}
