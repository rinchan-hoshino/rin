import type { ChatMessage, ChatOutput } from './types.js';
import type { ReplyContext } from './input-normalization.js';
interface InboxRow { id: string; thread: string; payload: string; state: string; receipt: string | null; error: string | null; created: number; }
interface DeliveryRow { id: string; route: string; payload: string; sent_payload: string | null; message_id: string | null; state: string; error: string | null; updated: number; item_group: string | null; }
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class ChatStore {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,thread TEXT NOT NULL,payload TEXT NOT NULL,
        state TEXT NOT NULL,receipt TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound_messages(adapter TEXT NOT NULL,chat_id TEXT NOT NULL,topic_id TEXT NOT NULL,message_id TEXT NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(adapter,chat_id,topic_id,message_id));
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,route TEXT NOT NULL,payload TEXT NOT NULL,
        sent_payload TEXT,message_id TEXT,state TEXT NOT NULL,error TEXT,updated INTEGER NOT NULL,item_group TEXT);
      UPDATE inbox SET state='uncertain',error='Interrupted while submitting to the agent' WHERE state='submitting';
      UPDATE deliveries SET state=CASE WHEN message_id IS NULL THEN 'uncertain' ELSE 'pending' END,
        error='Interrupted while sending' WHERE state='sending';`);
    if(!this.db.prepare('PRAGMA table_info(deliveries)').all().some(c=>c.name==='item_group')) this.db.exec('ALTER TABLE deliveries ADD COLUMN item_group TEXT');
  }
  cursor<T = unknown>(key: string): T | undefined { const r = this.db.prepare('SELECT value FROM cursors WHERE key=?').get(key); return r ? JSON.parse(String(r.value)) as T : undefined; }
  setCursor(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?)').run(key, JSON.stringify(value)); }
  admit(adapterId: string, thread: string, message: ChatMessage) {
    const id = message.topicId ? JSON.stringify([adapterId, message.chatId, String(message.topicId), message.id]) : JSON.stringify([adapterId, message.chatId, message.id]);
    const payload = JSON.stringify(message);
    const old = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
    // Telegram edits replace a payload only while it is still pending. Once we
    // begin submission, the provider edit cannot tell us whether retrying would
    // duplicate an agent turn, so preserve the accepted original instead.
    if (old) {
      // The durable inbox payload is the accepted submission. The separate
      // context index may still track a later provider edit for future replies.
      if (message.edited === true) this.indexInbound(adapterId,message,payload);
      if (message.edited === true && old.state === 'pending') {
        this.db.prepare('UPDATE inbox SET payload=? WHERE id=?').run(payload,id);
        return { id, fresh: true, replaced: true };
      }
      return { id, fresh: false };
    }
    this.db.prepare("INSERT INTO inbox(id,thread,payload,state,created) VALUES(?,?,?,'pending',?)").run(id, thread, payload, Date.now());
    this.indexInbound(adapterId,message,payload);
    return { id, fresh: true };
  }
  private indexInbound(adapterId: string, message: ChatMessage, payload: string) {
    this.db.prepare('INSERT OR REPLACE INTO inbound_messages(adapter,chat_id,topic_id,message_id,payload) VALUES(?,?,?,?,?)')
      .run(adapterId,String(message.chatId),String(message.topicId || ''),String(message.id),payload);
  }
  replyContext(adapterId: string, message: ChatMessage): ReplyContext | undefined {
    if (message.reply) return message.reply;
    if (!message.replyTo) return undefined;
    const row=this.db.prepare('SELECT payload FROM inbound_messages WHERE adapter=? AND chat_id=? AND topic_id=? AND message_id=?')
      .get(adapterId,String(message.chatId),String(message.topicId || ''),String(message.replyTo)) as {payload?: string} | undefined;
    const priorKey=message.topicId ? JSON.stringify([adapterId,message.chatId,String(message.topicId),message.replyTo]) : JSON.stringify([adapterId,message.chatId,message.replyTo]);
    const inbox=row?.payload ? row : this.db.prepare('SELECT payload FROM inbox WHERE id=?').get(priorKey) as {payload?: string} | undefined;
    if (!inbox?.payload) {
      const route=message.topicId ? JSON.stringify([adapterId,String(message.chatId),String(message.topicId)]) : JSON.stringify([adapterId,String(message.chatId)]);
      const sent=this.db.prepare('SELECT sent_payload,payload FROM deliveries WHERE route=? AND message_id=? ORDER BY updated DESC LIMIT 1').get(route,String(message.replyTo)) as {sent_payload?: string; payload?: string} | undefined;
      if (!sent?.sent_payload && !sent?.payload) return {messageId:String(message.replyTo),unavailable:true};
      try {
        const output=JSON.parse(sent.sent_payload || sent.payload || '{}') as ChatOutput;
        return {messageId:String(message.replyTo),authorName:'assistant',...(output.text?{text:output.text}:{}),...(output.files?.length?{media:output.files.map(file=>({kind:file.mimeType?.startsWith('image/')?'image':file.mimeType?.startsWith('video/')?'video':file.mimeType?.startsWith('audio/')?'audio':'file',name:file.name,mimeType:file.mimeType,path:file.path}))}:{}),...(!output.text && !output.files?.length?{unavailable:true}:{})};
      } catch { return {messageId:String(message.replyTo),unavailable:true}; }
    }
    try {
      const quoted=JSON.parse(inbox.payload) as ChatMessage;
      return {messageId:String(message.replyTo),...(quoted.userId?{authorId:String(quoted.userId)}:{}),...(quoted.userName?{authorName:quoted.userName}:{}),...(quoted.text?{text:quoted.text}:{}),...(quoted.files?.length?{media:quoted.files.map(file=>({kind:file.mimeType?.startsWith('image/')?'image':file.mimeType?.startsWith('video/')?'video':file.mimeType?.startsWith('audio/')?'audio':'file',name:file.name,mimeType:file.mimeType,path:file.path}))}:{}),...(!quoted.text && !quoted.files?.length?{unavailable:true}:{})};
    } catch { return {messageId:String(message.replyTo),unavailable:true}; }
  }
  pending() { return this.db.prepare("SELECT * FROM inbox WHERE state='pending' ORDER BY created").all() as unknown as InboxRow[]; }
  inboxState(id: string, state: string, receipt: string | null = null, error: string | null = null) {
    this.db.prepare('UPDATE inbox SET state=?,receipt=COALESCE(?,receipt),error=? WHERE id=?').run(state, receipt, error, id);
  }
  stage(id: string, route: string, output: ChatOutput, group: string | null = null) {
    const payload = JSON.stringify(output);
    const existing = this.delivery(id);
    if (existing?.payload === payload) return;
    if (existing?.state === 'uncertain') return; // Never silently repeat an ambiguous remote send.
    this.db.prepare(`INSERT INTO deliveries(id,route,payload,state,updated,item_group) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated,
      state=CASE WHEN deliveries.state='sending' THEN 'sending' ELSE 'pending' END`).run(id, route, payload, Date.now(),group);
  }
  retire(group: string, liveIds: string[]) {
    for(const row of this.db.prepare('SELECT * FROM deliveries WHERE item_group=?').all(group) as unknown as DeliveryRow[]) {
      if(liveIds.includes(row.id) || row.state==='uncertain')continue;
      if(row.message_id || row.state==='sending') this.stage(row.id,row.route,{delete:true},group);
      else this.db.prepare("UPDATE deliveries SET state='deleted' WHERE id=?").run(row.id);
    }
  }
  delivery(id: string) { return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as unknown as DeliveryRow | undefined; }
  outgoing() { return this.db.prepare("SELECT * FROM deliveries WHERE state='pending' ORDER BY updated").all() as unknown as DeliveryRow[]; }
  sending(id: string) { this.db.prepare("UPDATE deliveries SET state='sending',error=NULL WHERE id=?").run(id); }
  sent(id: string, payload: string, messageId: string | null) {
    this.db.prepare(`UPDATE deliveries SET sent_payload=?,message_id=?,
      state=CASE WHEN payload=? THEN 'sent' ELSE 'pending' END,error=NULL WHERE id=?`).run(payload, messageId==null?null:String(messageId), payload, id);
  }
  failed(id: string, error: unknown, retryable = false) {
    this.db.prepare('UPDATE deliveries SET state=?,error=? WHERE id=?').run(retryable ? 'pending' : 'uncertain', String(error).slice(0, 300), id);
  }
  status() {
    return {
      inbox: this.db.prepare('SELECT state,count(*) AS count FROM inbox GROUP BY state').all(),
      outbox: this.db.prepare('SELECT state,count(*) AS count FROM deliveries GROUP BY state').all(),
    };
  }
  close() { this.db.close(); }
}

export function stableId(...parts: unknown[]) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
