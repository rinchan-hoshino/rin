import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ACTIONS = new Set(['script', 'move', 'follow', 'place', 'break', 'use', 'withdraw', 'deposit', 'wait', 'say', 'pause', 'resume', 'cancel', 'inspectBlock', 'inspectInventory']);
// The game runtime owns script semantics and budgets. The bridge only checks
// that a program is a bounded JSON envelope made of string-valued instructions.
const SCRIPT_OPS = new Set(['move', 'follow', 'place', 'break', 'use', 'withdraw', 'deposit', 'wait', 'say', 'set', 'add', 'branch', 'jump', 'inspectBlock', 'inspectInventory']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, name, max = 4096) => {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid Minecraft ${name}`);
  return value;
};
const syncDirectory = async path => { const dir = await open(path, 'r'); try { await dir.sync(); } finally { await dir.close(); } };

function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Minecraft endpoint must be a loopback HTTP origin');
  return url;
}

function validateMessage(raw, lock) {
  if (!raw || raw.version !== 1) throw new Error('Unsupported Minecraft message version');
  const message = { version: 1, id:text(raw.id, 'message id', 512), serverId:text(raw.serverId, 'server id', 512), playerUuid:text(raw.playerUuid, 'player UUID', 64), maidUuid:text(raw.maidUuid, 'maid UUID', 64), conversationId:text(raw.conversationId, 'conversation id', 512), text: typeof raw.text === 'string' && raw.text.length <= 100000 ? raw.text : (() => { throw new Error('Invalid Minecraft text'); })(), occurredAt:text(raw.occurredAt, 'occurredAt', 128) };
  if (!UUID.test(message.playerUuid) || !UUID.test(message.maidUuid) || !Number.isFinite(Date.parse(message.occurredAt))) throw new Error('Invalid Minecraft identity or timestamp');
  if (lock && (message.serverId !== lock.serverId || message.playerUuid !== lock.playerUuid || message.maidUuid !== lock.maidUuid)) throw new Error('Minecraft source does not match configured server/player/maid lock');
  return Object.freeze(message);
}

function validateTask(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task) || !ACTIONS.has(task.action) || typeof task.jobId !== 'string' || !task.jobId || task.jobId.length > 512 || !task.args || typeof task.args !== 'object' || Array.isArray(task.args)) throw new Error('Invalid Minecraft task');
  const args = {};
  for (const [key, value] of Object.entries(task.args)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16384) throw new Error('Invalid Minecraft task arguments');
    args[key] = value;
  }
  if (task.action === 'script') {
    let program; try { program = JSON.parse(args.program); } catch { throw new Error('Minecraft script program must be JSON'); }
    if (!program || program.version !== 1 || !Array.isArray(program.steps) || !program.steps.length) throw new Error('Invalid Minecraft script program');
    for (const step of program.steps) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !SCRIPT_OPS.has(step.op)) throw new Error('Invalid Minecraft script step');
      for (const [key, value] of Object.entries(step)) if (key !== 'op' && (typeof value !== 'string' || value.length > 16384)) throw new Error('Invalid Minecraft script step argument');
    }
  }
  if (['pause', 'resume', 'cancel'].includes(task.action) && (!args.targetJobId || Object.keys(args).some(key => key !== 'targetJobId'))) throw new Error('Minecraft control task requires targetJobId only');
  return { jobId:task.jobId, action:task.action, args };
}

export class MinecraftTransport {
  constructor({ endpoint, secret, stateFile, source, enqueue, fetchImpl = fetch, timeoutMs = 10000 }) {
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('Missing dedicated Minecraft bearer token');
    if (!source || typeof source !== 'object' || !source.serverId || !UUID.test(source.playerUuid || '') || !UUID.test(source.maidUuid || '')) throw new Error('Minecraft source lock requires serverId, playerUuid, and maidUuid');
    if (typeof stateFile !== 'string' || !stateFile || typeof enqueue !== 'function') throw new Error('Invalid Minecraft transport configuration');
    this.endpoint = loopbackEndpoint(endpoint); this.secret = secret; this.path = stateFile; this.lockPath = `${stateFile}.lock`; this.source = source; this.enqueue = enqueue; this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.token = randomUUID(); this.writeTail = Promise.resolve(); this.operationTail = Promise.resolve();
  }
  static async inspectLock(stateFile) {
    try {
      const metadata = JSON.parse(await readFile(`${stateFile}.lock`, 'utf8'));
      let processAlive;
      if (Number.isInteger(metadata.pid) && metadata.pid > 0) {
        try { process.kill(metadata.pid, 0); processAlive = true; }
        catch (error) { processAlive = error.code === 'EPERM' ? true : false; }
      }
      return {exists:true,metadata,processAlive};
    } catch (error) { if (error?.code === 'ENOENT') return {exists:false}; throw new Error('Invalid Minecraft transport lock'); }
  }
  static async recoverStaleLock(stateFile, {minimumAgeMs=60000,nowMs=Date.now()} = {}) {
    const inspection=await this.inspectLock(stateFile);
    if (!inspection.exists || inspection.processAlive !== false) throw new Error('Minecraft transport lock is not confirmed stale');
    const createdAt=Date.parse(inspection.metadata.createdAt);
    if (!Number.isFinite(createdAt) || nowMs-createdAt < minimumAgeMs) throw new Error('Minecraft transport lock is too recent');
    const path=`${stateFile}.lock`, expected=JSON.stringify(inspection.metadata);
    if (await readFile(path,'utf8') !== expected) throw new Error('Minecraft transport lock changed during recovery');
    await unlink(path); await syncDirectory(dirname(stateFile));
  }
  async open() {
    await mkdir(dirname(this.path), { recursive:true, mode:0o700 });
    try { this.lock = await open(this.lockPath, 'wx', 0o600); } catch (error) { if (error?.code === 'EEXIST') throw new Error('Minecraft transport is already running; inspect its lock before recovery'); throw error; }
    try {
      await this.lock.writeFile(JSON.stringify({version:1,token:this.token,pid:process.pid,createdAt:new Date().toISOString()})); await this.lock.sync(); await syncDirectory(dirname(this.path));
      try { this.state = JSON.parse(await readFile(this.path, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; this.state = {version:1,pages:[],inbox:{},outbox:{}}; await this.save(); }
      if (this.state?.version !== 1 || !Array.isArray(this.state.pages) || !this.state.inbox || !this.state.outbox) throw new Error('Invalid Minecraft transport state');
      await chmod(this.path, 0o600);
      return this;
    } catch (error) { await this.close(); throw error; }
  }
  async save() {
    const snapshot = `${JSON.stringify(this.state)}\n`, temporary = `${this.path}.${this.token}.tmp`;
    const write = this.writeTail.then(async () => { const file = await open(temporary, 'w', 0o600); try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); } await rename(temporary, this.path); await syncDirectory(dirname(this.path)); });
    this.writeTail = write.catch(() => {}); return write;
  }
  async close() {
    await this.operationTail; await this.writeTail; await this.lock?.close().catch(() => {}); this.lock = undefined;
    try { const lock = JSON.parse(await readFile(this.lockPath, 'utf8')); if (lock.token === this.token) { await unlink(this.lockPath); await syncDirectory(dirname(this.path)); } } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  async request(path, options = {}) {
    const response = await this.fetch(new URL(path, this.endpoint), { ...options, redirect:'error', headers:{ authorization:`Bearer ${this.secret}`, 'content-type':'application/json', ...options.headers }, signal:AbortSignal.timeout(this.timeoutMs) });
    let body; try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(`Minecraft HTTP ${response.status}${body?.error ? `: ${body.error}` : ''}`);
    return body;
  }
  exclusive(operation) {
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => {});
    return result;
  }
  async syncOnce() {
    return this.exclusive(async () => {
      await this.forwardAndAck();
      const cursor = this.state.afterCursor;
      const query = new URLSearchParams({limit:'256'});
      if (cursor !== undefined) query.set('after', cursor);
      const page = await this.request(`/v1/inbox?${query}`, {method:'GET'});
      if (!page || page.version !== 1 || !Array.isArray(page.messages) || typeof page.nextCursor !== 'string') throw new Error('Invalid Minecraft inbox response');
      const ids = [];
      for (const raw of page.messages) {
        const message = validateMessage(raw);
        if (message.serverId !== this.source.serverId) throw new Error('Minecraft source does not match configured server lock');
        // One game inbox may contain other players. Consume its cursor without
        // admitting those identities or allowing them to block the bound owner.
        if (message.playerUuid !== this.source.playerUuid || message.maidUuid !== this.source.maidUuid) continue;
        const fingerprint = hash(message);
        const old = this.state.inbox[message.id];
        if (old && old.fingerprint !== fingerprint) throw new Error(`Minecraft message ID conflict: ${message.id}`);
        if (!old) {
          this.state.inbox[message.id] = {message, fingerprint, forwarded:false};
          await this.save();
        }
        ids.push(message.id);
      }
      if (ids.length || page.nextCursor !== cursor) {
        const previous = this.state.pages.at(-1);
        if (!previous || previous.throughCursor !== page.nextCursor) {
          this.state.pages.push({throughCursor:page.nextCursor,ids});
          await this.save();
        }
      }
      await this.forwardAndAck();
    });
  }
  async forwardAndAck() {
    while (this.state.pages.length) {
      const page = this.state.pages[0];
      for (const id of page.ids) {
        const record = this.state.inbox[id];
        if (!record) throw new Error(`Missing durable Minecraft message: ${id}`);
        if (!record.forwarded) {
          await this.enqueue(validateMessage(record.message, this.source));
          record.forwarded = true;
          await this.save();
        }
      }
      await this.request('/v1/inbox/ack', {method:'POST',body:JSON.stringify({throughCursor:page.throughCursor})});
      this.state.afterCursor = page.throughCursor;
      this.state.pages.shift();
      await this.save();
    }
  }
  read(messageId) {
    const record = this.state.inbox[messageId];
    if (!record) throw new Error('Unknown Minecraft message');
    return validateMessage(record.message, this.source);
  }
  async send({id,messageId,kind,text:replyText,task}) {
    return this.exclusive(async () => {
      text(id, 'outbound id', 512);
      const original = this.read(messageId);
      let message;
      if (kind === 'chat') {
        if (typeof replyText !== 'string' || !replyText.trim() || replyText.length > 2000 || task !== undefined) throw new Error('Invalid Minecraft chat reply');
        message = {version:1,id,replyTo:messageId,playerUuid:original.playerUuid,maidUuid:original.maidUuid,kind:'chat',text:replyText};
      } else if (kind === 'task') {
        if (replyText !== undefined) throw new Error('Minecraft task reply cannot include text');
        message = {version:1,id,replyTo:messageId,playerUuid:original.playerUuid,maidUuid:original.maidUuid,kind:'task',task:validateTask(task)};
      } else throw new Error('Minecraft reply kind must be chat or task');
      const digest = hash(message);
      const old = this.state.outbox[id];
      if (old) {
        if (old.fingerprint !== digest) throw new Error('Minecraft outbound ID reused with different content');
        return old.result || {id,state:'uncertain',replyTo:messageId};
      }
      this.state.outbox[id] = {fingerprint:digest,message,attempted:true};
      await this.save();
      try {
        const result = await this.request('/v1/outbox', {method:'POST',body:JSON.stringify(message)});
        if (!result || result.id !== id || result.replyTo !== messageId || result.playerUuid !== original.playerUuid || result.maidUuid !== original.maidUuid || !['sent','accepted','duplicate','uncertain'].includes(result.state)) throw new Error('Invalid Minecraft outbox receipt');
        this.state.outbox[id].result = result;
        await this.save();
        return result;
      } catch {
        const result = {id,state:'uncertain',replyTo:messageId,playerUuid:original.playerUuid,maidUuid:original.maidUuid};
        this.state.outbox[id].result = result;
        await this.save();
        return result;
      }
    });
  }
  async jobs(messageId) {
    const original = this.read(messageId);
    const page = await this.request('/v1/jobs', {method:'GET'});
    if (!page || page.version !== 1 || !Array.isArray(page.jobs)) throw new Error('Invalid Minecraft jobs response');
    return {messageId,jobs:page.jobs.filter(job => job?.playerUuid === original.playerUuid && job?.maidUuid === original.maidUuid)};
  }
  async inspect(messageId) {
    const original = this.read(messageId);
    const query = new URLSearchParams({playerUuid:original.playerUuid,maidUuid:original.maidUuid});
    const result = await this.request(`/v1/inspect?${query}`, {method:'GET'});
    if (!result || result.version !== 1 || (result.player !== null && result.player?.uuid !== original.playerUuid) || (result.maid !== null && result.maid?.uuid !== original.maidUuid) || !Array.isArray(result.nearbyContainers) || !Array.isArray(result.nearbyBlocks) || !Array.isArray(result.jobs)) throw new Error('Invalid Minecraft inspection response');
    return result;
  }
}
