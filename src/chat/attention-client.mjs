import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// Durable forwarding reuses the existing Discord Gateway; it never connects a
// second bot consumer. Retries are safe because Nerve admits by message ID.
export class AttentionClient {
  constructor(configPath, store, {fetchImpl=globalThis.fetch, log=console}={}) {
    const config=JSON.parse(readFileSync(configPath,'utf8'));
    const secrets=JSON.parse(readFileSync(resolve(dirname(configPath),'secrets.json'),'utf8'));
    if(!Number.isInteger(config.port) || config.port<1 || config.port>65535 || typeof secrets.NERVE_TOKEN!=='string' || secrets.NERVE_TOKEN.length<24)throw Error('Invalid attention service connection');
    this.url=`http://127.0.0.1:${config.port}/attention/messages`;
    this.token=secrets.NERVE_TOKEN; this.store=store;this.fetch=fetchImpl;this.log=log;this.busy=false;this.stopped=false;this.abort=new AbortController();
    store.db.exec(`CREATE TABLE IF NOT EXISTS attention_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);`);
  }
  observe(record) {
    this.store.db.prepare("INSERT OR IGNORE INTO attention_outbox VALUES(?,?,'pending',?)").run(record.id,JSON.stringify(record),Date.now());
  }
  async flush() {
    if(this.busy || this.stopped)return;
    this.busy=true;
    try {
      for(const row of this.store.db.prepare("SELECT id,payload FROM attention_outbox WHERE state='pending' ORDER BY created LIMIT 100").all()) {
        if(this.stopped)break;
        const response=await this.fetch(this.url,{method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:row.payload,redirect:'error',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(10000)])});
        await response.body?.cancel();
        if(!response.ok)throw Error(`Attention HTTP ${response.status}`);
        this.store.db.prepare("UPDATE attention_outbox SET state='delivered' WHERE id=?").run(row.id);
      }
    } finally {this.busy=false;}
  }
  stop() {this.stopped=true;this.abort.abort();}
}
