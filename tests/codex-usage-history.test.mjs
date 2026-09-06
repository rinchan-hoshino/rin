import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexTokenTrend, parseCodexUsageRecord } from '../src/chat/codex-usage-history.mjs';
import { buildUsageCostTrendView, renderCodexUsageCardPng } from '../src/chat/usage-card.ts';
const context = JSON.stringify({type:'session_meta',payload:{id:'thread-1',model_provider:'openai'}})+'\n'+JSON.stringify({type:'turn_context',payload:{turn_id:'turn-1',model:'gpt-6-astra'}})+'\n';
const record = (id, timestamp = '2026-09-06T16:01:00Z', total = 110) => context + JSON.stringify({ type: 'token_usage_record', timestamp, payload: { response_id: id, thread_id:'thread-1', turn_id:'turn-1', usage: { input_tokens: total - 10, cached_input_tokens: 80, output_tokens: 10, total_tokens: total }, turn_token_usage: { total_tokens: 999999 } } }) + '\n';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rin-codex-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'sessions')); await mkdir(join(dir, 'archived_sessions'));
  return { dir, options: { codexHome: dir, dataDir: join(dir, 'data'), now: new Date('2026-09-07T03:00:00Z'), afterDay: '2026-09-05' } };
}
test('uses per-response tokens including cache once, Shanghai day, unknown gaps and cutover', async t => {
  const {dir, options} = await fixture(t);
  await writeFile(join(dir, 'sessions', 'old-creation-date.jsonl'), record('a') + record('b', '2026-09-06T15:59:00Z') + record('legacy-overlap', '2026-09-05T01:00:00Z'));
  await writeFile(join(dir, 'archived_sessions', 'copy.jsonl'), record('a'));
  const trend = await readCodexTokenTrend(options);
  assert.equal(trend.total_tokens, 220); assert.equal(trend.partial, false);
  assert.equal(trend.points.at(-1).total_tokens, 110); assert.equal(trend.points.at(-2).input_tokens, 20);
  assert.equal(trend.points.at(-3).total_tokens, null); assert.equal(trend.cost_total, null); assert.equal(trend.account, null);
  assert.equal((await readCodexTokenTrend(options)).total_tokens, 220);
  const costTrend = {...trend,total_cost:0.00156,peak_cost:0.00078};
  const view = buildUsageCostTrendView(costTrend); assert.equal(view.axisLabel, 'USD/DAY'); assert.equal(view.values.at(-3), null);
  assert.ok(renderCodexUsageCardPng({accountId: 'test', windows: []}, {trend: costTrend}).length > 100);
});
test('bounded resume, append, oversized lines and partial tails never store message bodies', async t => {
  const {dir, options} = await fixture(t), file = join(dir, 'sessions', 'session.jsonl');
  const secret = 'PRIVATE_MESSAGE_MARKER';
  await writeFile(file, JSON.stringify({type:'response_item', text: secret + 'x'.repeat(600000)}) + '\n' + record('a'));
  let trend;
  for (let i = 0; i < 10; i++) { trend = await readCodexTokenTrend({...options, maxBytes: 100000}); if (!trend.partial) break; }
  assert.equal(trend.total_tokens, 110); assert.equal(trend.partial, false);
  await appendFile(file, '{"message":"' + secret);
  trend = await readCodexTokenTrend(options); assert.equal(trend.partial, true);
  assert.equal((await readFile(join(dir, 'data', 'usage', 'codex-history-v2.sqlite'))).includes(Buffer.from(secret)), false);
  await appendFile(file, '"}\n' + record('b'));
  trend = await readCodexTokenTrend(options); assert.equal(trend.total_tokens, 220); assert.equal(trend.partial, false);
});
test('conflicts and invalid candidate records mark incomplete coverage', async t => {
  const {dir, options} = await fixture(t);
  await writeFile(join(dir, 'sessions', 's.jsonl'), record('a') + record('a', undefined, 120) + '{"type":"token_usage_record","payload":{}}\n');
  const trend = await readCodexTokenTrend(options);
  assert.equal(trend.total_tokens, 110); assert.equal(trend.partial, true); assert.equal(trend.warnings.length, 2);
  assert.equal(parseCodexUsageRecord('{"type":"event_msg","payload":{"total_tokens":1000}}'), null);
});

test('Standard price snapshot applies full-request tiers and leaves unknown prices unpriced', async () => {
  const { estimateCodexUsageCost } = await import('../src/chat/codex-usage-pricing.mjs');
  const usage = {input: 20000, cached: 252000, cache_write:0, output:1000};
  assert.equal(estimateCodexUsageCost(usage, 'gpt-6-astra'), 0.502);
  assert.equal(estimateCodexUsageCost({...usage, input:20001}, 'gpt-6-astra'), 0.97902);
  assert.equal(estimateCodexUsageCost(usage, 'gpt-5.6-sol'), 0.2008);
  assert.equal(estimateCodexUsageCost(usage, 'codex-auto-review'), null);
  assert.equal(estimateCodexUsageCost({...usage, cache_write:1}, 'gpt-6-astra'), null);
});

test('binds nearest preceding model per request, including model changes within one turn', async t => {
  const {dir, options} = await fixture(t), file = join(dir, 'sessions', 's.jsonl');
  await writeFile(file, record('a'));
  let trend = await readCodexTokenTrend(options);
  assert.equal(trend.points.at(-1).cost_total, 0.00078);
  await appendFile(file, JSON.stringify({type:'turn_context',payload:{turn_id:'turn-1',model:'gpt-5.6-luna'}})+'\n'+record('b').slice(context.length));
  trend = await readCodexTokenTrend(options);
  assert.ok(Math.abs(trend.points.at(-1).cost_total - 0.0007976) < 1e-12);
  await appendFile(file, JSON.stringify({type:'turn_context',payload:{turn_id:'turn-1',model:'codex-auto-review'}})+'\n'+record('c').slice(context.length));
  trend = await readCodexTokenTrend(options);
  assert.equal(trend.unpricedRequests, 1); assert.equal(trend.unpricedModels['codex-auto-review'], 1); assert.equal(trend.partial, true);
});

test('single USD curve uses only Codex and never reads legacy cost history', async t => {
  const {executeUsage} = await import('../src/chat/usage.mjs');
  const {dir,options} = await fixture(t);
  await mkdir(join(options.dataDir,'usage'),{recursive:true});
  const historyPath = join(options.dataDir,'usage','cost-history.json');
  const history = 'invalid legacy file deliberately unreadable as JSON';
  await writeFile(historyPath,history);
  await writeFile(join(dir,'sessions','s.jsonl'),record('a'));
  const result = await executeUsage('text',{dataDir:options.dataDir,config:{codexHome:dir},now:()=>options.now,provider:{readRateLimits:async()=>({})}});
  assert.match(result.text,/2026-09-07 至 2026-09-07/); assert.match(result.text,/CODEX STANDARD EST/); assert.match(result.text,/不是订阅扣费/);
  assert.equal(await readFile(historyPath,'utf8'),history);
});

test('fork provenance session_meta never replaces the first file identity', async t => {
  const {dir, options} = await fixture(t);
  const fork = JSON.stringify({type:'session_meta',payload:{id:'thread-1',model_provider:'openai'}})+'\n'+JSON.stringify({type:'session_meta',payload:{id:'parent-thread',model_provider:'openai'}})+'\n';
  await writeFile(join(dir,'sessions','fork.jsonl'),fork+record('a').slice(context.indexOf('{"type":"turn_context"')));
  const trend = await readCodexTokenTrend(options);
  assert.equal(trend.unpricedRequests,0); assert.equal(trend.points.at(-1).cost_total,0.00078);
});
