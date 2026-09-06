import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitted } from '../policy.mjs';
import { COMMANDS, parseCommand } from '../commands.mjs';

const capabilities = Object.freeze({ edit: false, delete: true, typing: false, maxText: 4000 });

function segments(message) {
  return Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message || '') } }];
}

async function readLimited(response, limit) {
  if (!response.body?.[Symbol.asyncIterator]) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('OneBot attachment exceeds 20 MB limit');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.(); throw new Error('OneBot attachment exceeds 20 MB limit'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function downloadFiles(event, config, context, resolveFile) {
  const media = segments(event.message).filter((part) => ['image', 'file'].includes(part.type));
  if (!media.length) return [];
  const adapterId = path.basename(String(config.id || 'onebot')).replaceAll(/[^\p{L}\p{N}._-]/gu, '_') || 'onebot';
  const dir = path.join(context.dataDir, 'attachments', adapterId, randomUUID());
  await mkdir(dir, { recursive: true });
  return Promise.all(media.map(async (part, index) => {
    let url = part.data?.url;
    if (!url && part.type === 'file' && part.data?.file) {
      const resolved = await resolveFile(part.data.file);
      url = resolved?.url;
    }
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.attachmentTimeoutMs ?? 15000);
    timer.unref?.();
    // Attachment URLs may point at arbitrary QQ/CDN origins. The OneBot access
    // token authenticates only the gateway/API and must never follow media URLs.
    const response = await (config.fetch || fetch)(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`OneBot attachment download failed: HTTP ${response.status}`);
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared > 20 * 1024 * 1024) throw new Error('OneBot attachment exceeds 20 MB limit');
    const bytes = await readLimited(response, 20 * 1024 * 1024);
    clearTimeout(timer);
    const base = path.basename(part.data?.name || part.data?.file || `${part.type}-${index + 1}`).replaceAll(/[^\p{L}\p{N}._-]/gu, '_');
    const name = `${randomUUID()}-${base}`;
    const filePath = path.join(dir, name);
    await writeFile(filePath, bytes);
    return { path: filePath, name, mimeType: part.type === 'image' ? 'image/*' : undefined };
  })).then((items) => items.filter(Boolean));
}

export function createAdapter(config, context) {
  if (!config?.wsUrl) throw new Error('OneBot v11 adapter requires wsUrl');
  if (!Array.isArray(config.allowUsers) || config.allowUsers.length === 0) throw new Error('OneBot v11 adapter requires a non-empty allowUsers list');
  let socket;
  let stopped = true;
  let reconnectTimer;
  let onMessage;
  const commands = Array.isArray(context.commands) ? context.commands : COMMANDS;
  const pending = new Map();

  function rejectPending(error) {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  }

  async function handle(raw) {
    let event;
    try { event = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    if (event.echo != null && pending.has(String(event.echo))) {
      const call = pending.get(String(event.echo)); pending.delete(String(event.echo)); clearTimeout(call.timer);
      if (event.status === 'failed' || (event.retcode != null && event.retcode !== 0)) call.reject(Object.assign(new Error(`OneBot RPC failed (${event.retcode}): ${event.message || event.wording || 'unknown error'}`),{fallbackSafe:true}));
      else call.resolve(event.data ?? {});
      return;
    }
    if (event.post_type !== 'message') return;
    const kind = event.message_type === 'group' ? 'group' : 'dm';
    const userId = String(event.user_id);
    const parts = segments(event.message);
    const text = parts.filter((part) => part.type === 'text').map((part) => part.data?.text || '').join('').trim();
    // Admission deliberately precedes URL downloads and get_file calls.
    if (!admitted({...config,type:'onebot'},userId,kind,{command:Boolean(parseCommand(text,commands))})) return;
    const mentioned = parts.some((part) => part.type === 'at' && String(part.data?.qq) === String(event.self_id));
    if (kind === 'group' && config.requireMention !== false && !mentioned) return;
    const reply = parts.find((part) => part.type === 'reply')?.data?.id;
    const envelope = {
      id: String(event.message_id), chatId: String(kind === 'group' ? event.group_id : event.user_id), userId, kind,
      mentioned,
      text, files: [],
      ...(reply == null ? {} : { replyTo: String(reply) }),
    };
    if (context.isBound && !await context.isBound(envelope)) return;
    const files = await downloadFiles(event, config, context, (file) => call('get_file', { file }));
    await onMessage({ ...envelope, files });
  }

  async function connect() {
    const Ws = config.WebSocket || (await import('ws')).WebSocket;
    const headers = config.token ? { Authorization: `Bearer ${config.token}` } : {};
    socket = new Ws(config.wsUrl, { headers });
    socket.on('message', (data) => void handle(data).catch((error) => context.log?.error?.('OneBot event error', error)));
    socket.on('error', (error) => context.log?.warn?.('OneBot websocket error', error));
    socket.on('close', () => {
      rejectPending(new Error('OneBot websocket closed before RPC response'));
      if (!stopped) reconnectTimer = setTimeout(() => void connect().catch((error) => context.log?.warn?.('OneBot reconnect failed', error)), config.reconnectMs ?? 1000);
    });
    if (socket.readyState !== 1) {
      await new Promise((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const failed = (error) => { cleanup(); reject(error); };
        const cleanup = () => { socket.off?.('open', opened); socket.off?.('error', failed); };
        socket.once('open', opened);
        socket.once('error', failed);
      });
    }
  }

  function rpc(action, params) {
    if (!socket || socket.readyState !== 1) throw new Error('OneBot websocket is not connected');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`OneBot RPC timed out: ${action}`)); }, config.rpcTimeoutMs ?? 10000);
      pending.set(echo, { resolve, reject, timer });
      // Never retry sends: a missing response leaves delivery uncertain.
      socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error) { clearTimeout(timer); pending.delete(echo); reject(error); }
      });
    });
  }

  async function call(action, params) {
    if (!config.httpUrl) return rpc(action, params);
    const response = await (config.fetch || fetch)(`${config.httpUrl.replace(/\/$/, '')}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) }, body: JSON.stringify(params),
    });
    if (!response.ok) throw Object.assign(new Error(`OneBot HTTP ${action} failed: ${response.status}`),{fallbackSafe:true});
    const body = await response.json();
    if (body.status === 'failed' || (body.retcode != null && body.retcode !== 0)) throw Object.assign(new Error(`OneBot HTTP ${action} failed (${body.retcode})`),{fallbackSafe:true});
    return body.data || {};
  }

  return {
    capabilities,
    async start(callback) { if (!stopped) throw new Error('OneBot adapter already started'); stopped = false; onMessage = callback; await connect(); },
    async stop() { stopped = true; clearTimeout(reconnectTimer); rejectPending(new Error('OneBot adapter stopped')); const current = socket; socket = undefined; current?.close(); },
    async send(target, output) {
      if (output.editId) throw new Error('OneBot v11 does not define message editing');
      if(output.files?.some(file=>!(/^(image|audio|video)\//.test(file.mimeType || '')))) {
        // File transfer is an optional OneBot extension, not a v11 message segment.
        // Refuse mixed batches so a partial send cannot be mistaken for full success.
        if(output.text || output.files.length !== 1)throw new Error('OneBot file transfer requires one standalone file');
        const file=output.files[0], bytes=await readFile(file.path);
        if(bytes.length>20*1024*1024)throw new Error('OneBot attachment exceeds 20 MB limit');
        const group=target.kind==='group';
        const result=await call(group?'upload_group_file':'upload_private_file',{
          ...(group?{group_id:target.chatId}:{user_id:target.userId || target.chatId}),
          file:`base64://${bytes.toString('base64')}`,name:file.name || path.basename(file.path),upload_file:true,
        });
        const id=result?.file_id || result?.message_id;
        if(!id)throw new Error('OneBot file upload returned no file or message id');
        return {id:String(id)};
      }
      const message = [];
      if (output.replyTo) message.push({ type: 'reply', data: { id: String(output.replyTo) } });
      if (output.text) message.push({ type: 'text', data: { text: String(output.text) } });
      for (const file of output.files || []) {
        const mime=file.mimeType || '';
        const type=mime.startsWith('image/')?'image':mime.startsWith('audio/')?'record':mime.startsWith('video/')?'video':'file';
        // The OneBot gateway may run on another host; local paths are not portable.
        const bytes=await readFile(file.path);
        if(bytes.length>20*1024*1024)throw new Error('OneBot attachment exceeds 20 MB limit');
        message.push({type,data:{file:`base64://${bytes.toString('base64')}`,...(file.name?{name:file.name}:{})}});
      }
      if (!message.length) throw new Error('OneBot send requires text or files');
      const params = target.kind === 'group' ? { group_id: target.chatId, message } : { user_id: target.userId || target.chatId, message };
      const result = await call(target.kind === 'group' ? 'send_group_msg' : 'send_private_msg', params);
      if (result.message_id == null || result.message_id === '') throw new Error('OneBot send returned no message id');
      return { id: String(result.message_id) };
    },
    async delete(_target, id) {
      if (id == null || id === '') throw new Error('OneBot delete requires a message id');
      await call('delete_msg', { message_id: id });
    },
    async typing() { throw new Error('OneBot v11 does not define typing indicators'); },
  };
}
