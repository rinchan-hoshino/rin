import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export class ChatStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,thread TEXT NOT NULL,payload TEXT NOT NULL,
        state TEXT NOT NULL,receipt TEXT,error TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,route TEXT NOT NULL,payload TEXT NOT NULL,
        sent_payload TEXT,message_id TEXT,state TEXT NOT NULL,error TEXT,updated INTEGER NOT NULL,item_group TEXT);
      UPDATE inbox SET state='uncertain',error='Interrupted while submitting to Codex' WHERE state='submitting';
      UPDATE deliveries SET state=CASE WHEN message_id IS NULL THEN 'uncertain' ELSE 'pending' END,
        error='Interrupted while sending' WHERE state='sending';`);
    if(!this.db.prepare('PRAGMA table_info(deliveries)').all().some(c=>c.name==='item_group')) this.db.exec('ALTER TABLE deliveries ADD COLUMN item_group TEXT');
  }
  cursor(key) { const r = this.db.prepare('SELECT value FROM cursors WHERE key=?').get(key); return r ? JSON.parse(r.value) : undefined; }
  setCursor(key, value) { this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?)').run(key, JSON.stringify(value)); }
  admit(adapterId, thread, message) {
    const id = JSON.stringify([adapterId, message.chatId, message.id]);
    const payload = JSON.stringify(message);
    const old = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
    // Platforms may replay an event with updated incidental metadata. Its stable identity wins.
    if (old) return { id, fresh: false };
    this.db.prepare("INSERT INTO inbox(id,thread,payload,state,created) VALUES(?,?,?,'pending',?)").run(id, thread, payload, Date.now());
    return { id, fresh: true };
  }
  pending() { return this.db.prepare("SELECT * FROM inbox WHERE state='pending' ORDER BY created").all(); }
  inboxState(id, state, receipt = null, error = null) {
    this.db.prepare('UPDATE inbox SET state=?,receipt=COALESCE(?,receipt),error=? WHERE id=?').run(state, receipt, error, id);
  }
  stage(id, route, output, group = null) {
    const payload = JSON.stringify(output);
    const existing = this.delivery(id);
    if (existing?.payload === payload) return;
    if (existing?.state === 'uncertain') return; // Never silently repeat an ambiguous remote send.
    this.db.prepare(`INSERT INTO deliveries(id,route,payload,state,updated,item_group) VALUES(?,?,?,'pending',?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated,
      state=CASE WHEN deliveries.state='sending' THEN 'sending' ELSE 'pending' END`).run(id, route, payload, Date.now(),group);
  }
  retire(group, liveIds) {
    for(const row of this.db.prepare('SELECT * FROM deliveries WHERE item_group=?').all(group)) {
      if(liveIds.includes(row.id) || row.state==='uncertain')continue;
      if(row.message_id || row.state==='sending') this.stage(row.id,row.route,{delete:true},group);
      else this.db.prepare("UPDATE deliveries SET state='deleted' WHERE id=?").run(row.id);
    }
  }
  delivery(id) { return this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); }
  outgoing() { return this.db.prepare("SELECT * FROM deliveries WHERE state='pending' ORDER BY updated").all(); }
  sending(id) { this.db.prepare("UPDATE deliveries SET state='sending',error=NULL WHERE id=?").run(id); }
  sent(id, payload, messageId) {
    this.db.prepare(`UPDATE deliveries SET sent_payload=?,message_id=?,
      state=CASE WHEN payload=? THEN 'sent' ELSE 'pending' END,error=NULL WHERE id=?`).run(payload, messageId==null?null:String(messageId), payload, id);
  }
  failed(id, error, retryable = false) {
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

export function stableId(...parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
