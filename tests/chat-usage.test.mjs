import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCodexUsageProvider, executeUsage, normalizeUsageResponse, parseUsageArgs, renderCurrentUsage } from '../src/chat/usage.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rin-usage-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

const response = {
  accountId: 'must-not-leak',
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 35.5, windowDurationMins: 10080, resetsAt: 2_000_100_000 }, credits: { hasCredits: true, unlimited: false, balance: '12.50' } },
    spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, credits: null },
  },
};

test('usage arguments keep card/text/current/history compatibility and reject ambiguity', () => {
  assert.equal(parseUsageArgs('').mode, 'card');
  assert.equal(parseUsageArgs('card').mode, 'card');
  assert.equal(parseUsageArgs('text').mode, 'text');
  assert.equal(parseUsageArgs('current').mode, 'text');
  assert.deepEqual(parseUsageArgs('history --days 7 --json'), { mode: 'history', days: 7, json: true });
  assert.deepEqual(parseUsageArgs('--quota --days 7 --json'), { mode: 'history', days: 7, json: true });
  assert.equal(parseUsageArgs('--days 7').mode, 'legacy-tokens');
  assert.throws(() => parseUsageArgs('history --days 0'), /1-365/);
  assert.throws(() => parseUsageArgs('text --json'), /仅用于/);
  assert.throws(() => parseUsageArgs('nope'), /未知/);
});

test('multi-bucket current view reports used, remaining and reset without account identifiers', () => {
  const snapshot = normalizeUsageResponse(response, new Date('2026-09-05T00:00:00Z'));
  const text = renderCurrentUsage(snapshot);
  assert.match(text, /5 小时：已用 20%，剩余 80%/);
  assert.match(text, /1 周：已用 35.5%，剩余 64.5%/);
  assert.doesNotMatch(text, /Spark/);
  assert.match(text, /Credits：12.50/);
  assert.match(text, /北京时间/);
  assert.doesNotMatch(text, /must-not-leak/);
});

test('text reads injected provider and records only new private history', async t => {
  const dataDir = await fixture(t);
  let calls = 0;
  const result = await executeUsage('text', { dataDir, config: { codexHome: dataDir }, provider: { readRateLimits: async () => { calls++; return response; } }, now: () => new Date('2026-09-05T01:00:00Z') });
  assert.equal(calls, 1);
  assert.equal(result.files, undefined);
  assert.match(result.text, /Codex 额度/);
  const stored = await readFile(join(dataDir, 'usage', 'history.jsonl'), 'utf8');
  assert.equal(stored.trim().split('\n').length, 1);
  assert.doesNotMatch(stored, /must-not-leak/);
});

test('card returns PNG with a failure-only text fallback and history uses the new snapshots', async t => {
  const dataDir = await fixture(t);
  const provider = { readRateLimits: async () => response };
  const current = await executeUsage('card', { dataDir, config: { codexHome: dataDir }, provider, now: () => new Date('2026-09-05T01:00:00Z') });
  assert.equal(current.files?.[0].mimeType, 'image/png');
  assert.equal(current.files.length, 1);
  assert.equal(current.text, undefined);
  assert.match(current.fallbackText, /剩余 80%/);
  assert.deepEqual([...await readFile(current.files[0].path)].slice(0,8), [137,80,78,71,13,10,26,10]);
  await executeUsage('text', { dataDir, config: { codexHome: dataDir }, provider: { readRateLimits: async () => ({ rateLimitsByLimitId: { codex: { ...response.rateLimitsByLimitId.codex, primary: { ...response.rateLimitsByLimitId.codex.primary, usedPercent: 25 } } } }) }, now: () => new Date('2026-09-05T02:00:00Z') });
  const history = await executeUsage('history --days 2', { dataDir, now: () => new Date('2026-09-05T03:00:00Z') });
  assert.match(history.text, /共 2 次快照/);
  assert.match(history.text, /20% → 最新 25%/);
  const json = await executeUsage('history --days 2 --json', { dataDir, now: () => new Date('2026-09-05T03:00:00Z') });
  assert.match(json.text, /已导出/);
  assert.equal(json.files[0].mimeType, 'application/json');
  const report = JSON.parse(await readFile(json.files[0].path, 'utf8'));
  assert.equal(report.snapshots.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /Spark/);
});

test('missing current and history fields are explicit unknowns', async t => {
  const dataDir = await fixture(t);
  const empty = await executeUsage('history', { dataDir, now: () => new Date('2026-09-05T00:00:00Z') });
  assert.match(empty.text, /unknown/);
  const current = await executeUsage('text', { dataDir, config: { codexHome: dataDir }, provider: { readRateLimits: async () => ({ rateLimitsByLimitId: { codex: { limitId: 'codex', primary: {} } } }) } });
  assert.match(current.text, /已用 unknown，剩余 unknown/);
  assert.match(current.text, /重置时间 unknown/);
});

test('default provider uses the stable read-only app-server method', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    assert.equal(command, '/test/codex');
    assert.deepEqual(args, ['shim', 'app-server']);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {};
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        const request = JSON.parse(line); calls.push(request.method);
        const result = request.method === 'initialize' ? { userAgent: 'test' } : response;
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    return child;
  };
  const provider = createCodexUsageProvider({ config: { command: ['/test/codex', 'shim'] }, spawnImpl });
  assert.equal((await provider.readRateLimits()).rateLimitsByLimitId.codex.limitId, 'codex');
  assert.deepEqual(calls, ['initialize', 'account/rateLimits/read', 'account/read']);
});

test('empty fields stay unknown, parse errors are useful and legacy quota aliases history', async t => {
  assert.equal(normalizeUsageResponse({ rateLimits: { primary: { usedPercent: null, windowDurationMins: '', resetsAt: undefined } } }).limits[0].windows[0].usedPercent, null);
  const dataDir=await fixture(t);
  assert.match((await executeUsage('bogus',{dataDir})).text,/未知 usage 模式/);
  assert.match((await executeUsage('--days 7',{dataDir})).text,/旧 token telemetry 不可用/);
  const quota=await executeUsage('--quota',{dataDir});
  assert.match(quota.text,/历史数据 unknown/);
});
