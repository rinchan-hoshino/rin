import { CODEX_PRICING, estimateCodexUsageCost } from './codex-usage-pricing.mjs';
import { mkdir, readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const resolveCodexHome = value => value || process.env.CODEX_HOME || join(homedir(), '.codex');
import { DatabaseSync } from 'node:sqlite';

const dayOf = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const shiftDay = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
async function filesUnder(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(directory, entry.name)] : []));
  return results.flat().sort();
}

// Only per-response usage is additive. Cumulative turn/thread/token_count events
// can reset or repeat after compaction and must never enter this ledger.
export function parseCodexUsageRecord(line) {
  if (!line.includes('token_usage_record')) return null;
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event.type !== 'token_usage_record') return null;
  const payload = event.payload, usage = payload?.usage;
  if (typeof payload?.response_id !== 'string' || !payload.response_id || !usage || !Number.isFinite(Date.parse(event.timestamp))) return null;
  const values = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens'].map(key => usage[key]);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const [input, cached, output, total] = values;
  if (cached > input || total !== input + output) return null;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  if (!Number.isSafeInteger(cacheWrite) || cacheWrite < 0) return null;
  return { id: payload.response_id, thread: payload.thread_id || '', turn: payload.turn_id || '', day: dayOf(event.timestamp), input: input - cached, cached, cache_write: cacheWrite, output, total };
}

export async function readCodexTokenTrend({ codexHome, dataDir, now = new Date(), days = 14, afterDay = null, maxBytes = 32 * 1024 * 1024, maxMs = 1000 } = {}) {
  codexHome = resolveCodexHome(codexHome);
  const directory = join(dataDir, 'usage');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'codex-history-v2.sqlite'));
  try {
    db.exec(`PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, inode TEXT, offset INTEGER, skipping INTEGER, thread TEXT, provider TEXT); CREATE TABLE IF NOT EXISTS responses(provider TEXT, id TEXT, thread TEXT, turn TEXT, day TEXT, input INTEGER, cached INTEGER, cache_write INTEGER, output INTEGER, total INTEGER, model TEXT, PRIMARY KEY(provider,id)); CREATE TABLE IF NOT EXISTS turns(provider TEXT, thread TEXT, turn TEXT, model TEXT, PRIMARY KEY(provider,thread,turn)); CREATE TABLE IF NOT EXISTS warnings(kind TEXT PRIMARY KEY, count INTEGER);`);
    const files = (await Promise.all(['sessions', 'archived_sessions'].map(name => filesUnder(join(codexHome, name))))).flat();
    const lookup = db.prepare('SELECT * FROM files WHERE path=?');
    const save = db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)');
    const insert = db.prepare('INSERT OR IGNORE INTO responses VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    const existing = db.prepare('SELECT * FROM responses WHERE provider=? AND id=?');
    const warn = db.prepare('INSERT INTO warnings VALUES(?,1) ON CONFLICT(kind) DO UPDATE SET count=count+1');
    const saveTurn = db.prepare('INSERT OR REPLACE INTO turns VALUES(?,?,?,?)');
    const readTurn = db.prepare('SELECT model FROM turns WHERE provider=? AND thread=? AND turn=?');
    let bytesRead = 0, pendingFiles = 0;
    const started = Date.now();
    for (const path of files) {
      const metadata = await stat(path);
      const inode = String(metadata.ino);
      const prior = lookup.get(path);
      let offset = prior && prior.inode === inode && prior.offset <= metadata.size ? prior.offset : 0;
      let tail = '', skipping = offset ? Boolean(prior.skipping) : false;
      let thread = offset ? prior.thread : '', provider = offset ? prior.provider : '';
      if (offset < metadata.size && bytesRead < maxBytes && Date.now() - started < maxMs) {
        const handle = await open(path, 'r');
        try {
          while (offset < metadata.size && bytesRead < maxBytes && Date.now() - started < maxMs) {
            const buffer = Buffer.alloc(Math.min(256 * 1024, metadata.size - offset, maxBytes - bytesRead));
            const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, offset);
            if (!count) break;
            offset += count; bytesRead += count;
            // Latin1 preserves byte boundaries across chunks. Decode only complete
            // candidate records, and never retain large chat/image payloads.
            const parts = (tail + buffer.subarray(0, count).toString('latin1')).split('\n');
            tail = parts.pop();
            db.exec('BEGIN');
            try {
              for (const line of parts) {
                if (skipping) { skipping = false; continue; }
                const decoded = Buffer.from(line, 'latin1').toString('utf8');
                if (/"type"\s*:\s*"(?:session_meta|turn_context)"/.test(decoded)) {
                  let event;
                  try { event = JSON.parse(decoded); } catch { warn.run('invalid-context'); continue; }
                  if (event.type === 'session_meta' && !thread) {
                    thread = typeof event.payload?.id === 'string' ? event.payload.id : '';
                    provider = typeof event.payload?.model_provider === 'string' ? event.payload.model_provider : '';
                  } else if (event.type === 'turn_context') {
                    const turn = event.payload?.turn_id, model = event.payload?.model;
                    if (thread && typeof turn === 'string' && typeof model === 'string') {
                      saveTurn.run(provider, thread, turn, model);
                    }
                  }
                }
                const record = parseCodexUsageRecord(decoded);
                if (record) {
                  const previous = existing.get(provider, record.id);
                  if (previous && ['thread', 'turn', 'day', 'input', 'cached', 'cache_write', 'output', 'total'].some(key => previous[key] !== record[key])) warn.run('conflicting-response');
                  else insert.run(provider, record.id, record.thread, record.turn, record.day, record.input, record.cached, record.cache_write, record.output, record.total, readTurn.get(provider, record.thread, record.turn)?.model || null);
                } else if (/"type"\s*:\s*"token_usage_record"/.test(line)) warn.run('invalid-record');
              }
              if (tail.length >= Math.min(256 * 1024, maxBytes)) {
                if (/"type"\s*:\s*"(?:token_usage_record|turn_context|session_meta)"/.test(tail)) warn.run('oversized-record');
                tail = ''; skipping = true;
              }
              save.run(path, inode, skipping ? offset : offset - Buffer.byteLength(tail, 'latin1'), Number(skipping), thread, provider);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
          }
        } finally { await handle.close(); }
      }
      if (offset < metadata.size || tail || skipping) pendingFiles++;
    }
    const today = dayOf(now), first = shiftDay(today, -(days - 1));
    const rows = db.prepare('SELECT * FROM responses WHERE day>=? AND day<=?').all(first, today);
    const byDay = new Map();
    const unpricedModels = new Map();
    for (const record of rows) {
      if (afterDay && record.day <= afterDay) continue;
      const row = byDay.get(record.day) || { requests: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, total_tokens: 0, cost_total: 0, unpriced_requests: 0 };
      row.requests++; row.input_tokens += record.input; row.cache_read_tokens += record.cached; row.output_tokens += record.output; row.total_tokens += record.total;
      const cost = estimateCodexUsageCost(record, record.model);
      if (cost === null) { row.unpriced_requests++; const model = record.model || 'unknown'; unpricedModels.set(model, (unpricedModels.get(model) || 0) + 1); }
      else row.cost_total += cost;
      byDay.set(record.day, row);
    }
    const points = Array.from({ length: days }, (_, i) => {
      const timestamp = shiftDay(first, i), row = byDay.get(timestamp);
      return { timestamp, ...(row || {}), total_tokens: row?.total_tokens ?? null, cost_total: row && row.requests > row.unpriced_requests ? row.cost_total : null };
    });
    const unpricedRequests = [...unpricedModels.values()].reduce((sum, count) => sum + count, 0);
    const warnings = db.prepare('SELECT * FROM warnings').all();
    return { days, points, warnings, unpricedRequests, unpricedModels: Object.fromEntries(unpricedModels), pricing: CODEX_PRICING, total_tokens: points.reduce((sum, point) => sum + (point.total_tokens || 0), 0), peak_tokens: Math.max(0, ...points.map(point => point.total_tokens || 0)), partial: pendingFiles > 0 || warnings.length > 0 || unpricedRequests > 0, pendingFiles, files: files.length, bytesRead, source: 'local-codex-rollouts', account: null, cost_total: null, afterDay };
  } finally { db.close(); }
}
