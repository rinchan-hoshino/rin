import { spawn } from 'node:child_process';
import { renderCodexUsageCardPng } from './usage-card.ts';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const HISTORY_NAME = 'history.jsonl';
const DEFAULT_DAYS = 14;
const MAX_DAYS = 365;

const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = value => value === null ? null : Math.max(0, Math.min(100, value));

function usageHelp() {
  return [
    '用法：/usage [current|card|text|history] [--days N] [--json]',
    '',
    '  /usage             当前额度卡片（图片不受支持时仍返回完整文字）',
    '  /usage current     当前额度文字',
    '  /usage card        当前额度卡片',
    '  /usage text        当前额度文字',
    '  /usage history     Rin 启用此命令后记录的额度历史',
    '  /usage --quota     兼容旧命令，等同 history',
    '',
    '历史由 Rin 新快照和一次性独立迁移的历史组成；没有记录时会明确显示 unknown。',
    '旧版 token telemetry 参数（--tokens、--events、--group-by、--filter 等）依赖 Pi 事件流，新桥不提供。',
  ].join('\n');
}

export function parseUsageArgs(input = '') {
  const words = String(input).trim().split(/\s+/).filter(Boolean);
  if (words.some(word => word === '-h' || word === '--help')) return { mode: 'help', days: DEFAULT_DAYS, json: false };
  if (words[0] === '--quota') {
    words.shift();
    words.unshift('history');
  }
  const legacy = new Set(['--tokens','--events','--group-by','--filter','--all-time','--limit','--order-by','--asc','--desc','--list-dimensions']);
  if ((!words[0] || words[0].startsWith('-')) && words.some(word => legacy.has(word) || word === '--days')) return { mode: 'legacy-tokens', days: DEFAULT_DAYS, json: false };
  let mode = words[0] && !words[0].startsWith('-') ? words.shift().toLowerCase() : 'card';
  if (mode === 'current') mode = 'text';
  if (!['card', 'text', 'history'].includes(mode)) throw new Error(`未知 usage 模式：${mode}`);
  let days = DEFAULT_DAYS;
  let json = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === '--json') json = true;
    else if (word === '--days') {
      const raw = words[++index];
      if (!/^\d+$/.test(raw || '') || Number(raw) < 1 || Number(raw) > MAX_DAYS) throw new Error(`--days 必须是 1-${MAX_DAYS} 的整数`);
      days = Number(raw);
    } else throw new Error(`未知 usage 参数：${word}`);
  }
  if (mode !== 'history' && (days !== DEFAULT_DAYS || json)) throw new Error('--days 和 --json 仅用于 usage history');
  return { mode, days, json };
}

function normalizeWindow(value) {
  const used = clamp(finite(value?.usedPercent ?? value?.used_percent));
  const duration = finite(value?.windowDurationMins ?? value?.window_minutes);
  const reset = finite(value?.resetsAt ?? value?.resets_at);
  return {
    usedPercent: used,
    remainingPercent: used === null ? null : Math.round((100 - used) * 10) / 10,
    windowDurationMins: duration,
    resetsAt: reset,
  };
}

function normalizeLimit(value, fallbackId) {
  if (!value || typeof value !== 'object') return null;
  const windows = [];
  if (value.primary) windows.push({ name: 'primary', ...normalizeWindow(value.primary) });
  if (value.secondary) windows.push({ name: 'secondary', ...normalizeWindow(value.secondary) });
  const credits = value.credits && typeof value.credits === 'object' ? {
    hasCredits: Boolean(value.credits.hasCredits ?? value.credits.has_credits),
    unlimited: Boolean(value.credits.unlimited),
    balance: value.credits.balance === undefined || value.credits.balance === null ? null : String(value.credits.balance),
  } : null;
  return {
    id: String(value.limitId ?? value.limit_id ?? fallbackId ?? 'default'),
    name: value.limitName ?? value.limit_name ?? null,
    planType: value.planType ?? value.plan_type ?? null,
    windows,
    credits,
    spendControlReached: value.spendControlReached ?? value.spend_control_reached ?? null,
    rateLimitReachedType: value.rateLimitReachedType ?? value.rate_limit_reached_type ?? null,
  };
}

export function normalizeUsageResponse(response, now = new Date()) {
  const source = response?.rateLimitsByLimitId ?? response?.rate_limits_by_limit_id;
  let entries = source && typeof source === 'object' ? Object.entries(source) : [];
  if (!entries.length && (response?.rateLimits || response?.rate_limits)) entries = [['default', response.rateLimits ?? response.rate_limits]];
  const limits = entries.map(([id, value]) => normalizeLimit(value, id)).filter(Boolean);
  return { observedAt: new Date(now).toISOString(), limits, source: response };
}

function durationLabel(minutes) {
  if (minutes === null) return '窗口未知';
  if (minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function resetLabel(seconds, locale = 'zh-CN') {
  if (seconds === null) return '重置时间 unknown';
  const date = new Date(seconds > 1e11 ? seconds : seconds * 1000);
  return Number.isNaN(date.getTime()) ? '重置时间 unknown' : `重置 ${date.toLocaleString(locale, { timeZone: 'Asia/Shanghai' })}（北京时间）`;
}

export function renderCurrentUsage(snapshot) {
  const lines = ['Codex 额度'];
  if (!snapshot.limits.length) return `${lines[0]}\n当前额度 unknown`;
  for (const limit of snapshot.limits) {
    lines.push('', `${limit.name || limit.id}${limit.planType ? ` · ${limit.planType}` : ''}`);
    if (!limit.windows.length) lines.push('额度窗口 unknown');
    for (const window of limit.windows) {
      const used = window.usedPercent === null ? 'unknown' : `${window.usedPercent}%`;
      const remaining = window.remainingPercent === null ? 'unknown' : `${window.remainingPercent}%`;
      lines.push(`${durationLabel(window.windowDurationMins)}：已用 ${used}，剩余 ${remaining}`, resetLabel(window.resetsAt));
    }
    if (limit.credits) {
      const value = limit.credits.unlimited ? '无限' : limit.credits.hasCredits && limit.credits.balance !== null ? limit.credits.balance : '无可用余额';
      lines.push(`Credits：${value}`);
    }
    if (limit.spendControlReached === true) lines.push('已达到支出控制上限');
    if (limit.rateLimitReachedType) lines.push(`状态：${limit.rateLimitReachedType}`);
  }
  return lines.join('\n');
}

function historyPath(dataDir) { return join(dataDir, 'usage', HISTORY_NAME); }

async function appendSnapshot(dataDir, snapshot) {
  const directory = join(dataDir, 'usage');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(historyPath(dataDir), `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function readHistory(dataDir, days, now) {
  let body;
  try { body = await readFile(historyPath(dataDir), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const cutoff = new Date(now).getTime() - days * 86_400_000;
  return body.split('\n').filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line);
      return Date.parse(row?.observedAt) >= cutoff && Array.isArray(row?.limits) ? [row] : [];
    } catch { return []; }
  });
}

function renderHistory(rows, days) {
  if (!rows.length) return `Codex 额度历史（最近 ${days} 天）\n历史数据 unknown：Rin 尚未记录新的额度快照。`;
  const lines = [`Codex 额度历史（最近 ${days} 天，共 ${rows.length} 次快照）`];
  const series = new Map();
  for (const row of rows) for (const limit of row.limits) for (const window of limit.windows || []) {
    const key = `${limit.id}/${window.name}`;
    const list = series.get(key) || [];
    list.push({ at: row.observedAt, ...window });
    series.set(key, list);
  }
  if (!series.size) lines.push('历史数据 unknown：快照中没有额度窗口。');
  for (const [key, points] of series) {
    const first = points[0], last = points.at(-1);
    const delta = first.usedPercent === null || last.usedPercent === null ? 'unknown' : `${Math.round((last.usedPercent - first.usedPercent) * 10) / 10} 个百分点`;
    const crossedReset=points.some((point,index)=>index>0 && point.resetsAt!==null && points[index-1].resetsAt!==null && point.resetsAt!==points[index-1].resetsAt);
    lines.push('', key, `最早 ${first.usedPercent ?? 'unknown'}% → 最新 ${last.usedPercent ?? 'unknown'}%（变化 ${delta}）`, `最新剩余 ${last.remainingPercent ?? 'unknown'}%，${resetLabel(last.resetsAt)}`, ...(crossedReset?['期间跨过额度重置；快照变化不代表实际消费量。']:[]));
  }
  return lines.join('\n');
}

function cardWindowName(limit, window) {
  const minutes = window.windowDurationMins;
  const duration = minutes === null ? 'unknown' : minutes >= 10080 && minutes % 10080 === 0 ? 'weekly' : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}_hour` : `${minutes ?? 'unknown'}_minute`;
  if (limit.id === 'codex') return duration === 'weekly' ? 'weekly' : duration === '5_hour' ? 'five_hour' : duration;
  return `${limit.id}_${duration}`;
}

function isoReset(seconds) {
  if (seconds === null) return undefined;
  const date = new Date(seconds > 1e11 ? seconds : seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function accountName(response) {
  const account = response?.account ?? response?.accountInfo ?? response?.account_info ?? {};
  for (const value of [account.email, account.name, account.displayName, response?.email, response?.accountEmail]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function usageStatusForCard(snapshot) {
  const windows = snapshot.limits.flatMap(limit => (limit.windows || []).map(window => ({
    name: cardWindowName(limit, window),
    percentLeft: window.remainingPercent === null ? undefined : window.remainingPercent,
    resetAt: isoReset(window.resetsAt),
  })));
  const creditLines = snapshot.limits.flatMap(limit => {
    if (!limit.credits) return [];
    if (limit.credits.unlimited) return [`${limit.id.toUpperCase()} UNLIMITED`];
    if (limit.credits.hasCredits && limit.credits.balance !== null) return [`${limit.id.toUpperCase()} ${limit.credits.balance}`];
    return [];
  });
  return {
    // The app-server account id is deliberately never rendered or persisted.
    accountId: 'ACCOUNT UNKNOWN',
    accountName: accountName(snapshot.source),
    plan: snapshot.limits.find(limit => limit.id === 'codex')?.planType ?? snapshot.limits.find(limit => limit.planType)?.planType,
    windows,
    credits: creditLines.length ? creditLines.join('  ') : undefined,
  };
}

function costHistoryPath(dataDir) { return join(dataDir, 'usage', 'cost-history.json'); }

async function readCostTrend(dataDir, days = DEFAULT_DAYS) {
  let body;
  try { body = JSON.parse(await readFile(costHistoryPath(dataDir), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const rows = Array.isArray(body?.points) ? body.points : [];
  const points = rows.filter(row => typeof row?.date === 'string' && Number.isFinite(Number(row.cost_total)) && Number(row.cost_total) >= 0)
    .slice(-days).map(row => ({ timestamp: row.date, cost_total: Number(row.cost_total) }));
  // A partial time series would draw invented zero gaps. Render a curve only when
  // every requested daily observation is present and explicitly sourced.
  if (points.length !== days) return null;
  const total_cost = points.reduce((sum, point) => sum + point.cost_total, 0);
  return { days, points, total_cost, peak_cost: Math.max(0, ...points.map(point => point.cost_total)) };
}

function pngCard(snapshot, trend) {
  return renderCodexUsageCardPng(usageStatusForCard(snapshot), { trend: trend || undefined });
}

async function writeCard(dataDir, snapshot, trend) {
  const directory = join(dataDir, 'usage', 'cards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `codex-usage-${snapshot.observedAt.replace(/[^0-9A-Za-z]/g, '')}.png`);
  await writeFile(path, pngCard(snapshot, trend), { mode: 0o600 });
  const stale = (await readdir(directory)).filter(name => name.endsWith('.png') && name !== basename(path)).sort().slice(0, -7);
  await Promise.all(stale.map(name => rm(join(directory, name), { force: true })));
  return { path, name: basename(path), mimeType: 'image/png' };
}

export function createCodexUsageProvider({ config = {}, spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return { async readRateLimits() {
    const command = Array.isArray(config.command) && config.command.length ? config.command : ['codex'];
    return new Promise((resolve, reject) => {
      const child = spawnImpl(command[0], [...command.slice(1), 'app-server'], { env: { ...process.env, ...(config.codexHome ? { CODEX_HOME: config.codexHome } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = '', settled = false, nextId = 1;
      const pending = new Map();
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(value); };
      const request = (method, params) => new Promise((accept, decline) => {
        const id = nextId++;
        pending.set(String(id), { accept, decline });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      const timer = setTimeout(() => finish(new Error('Codex usage read timed out')), timeoutMs);
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => finish(new Error('Codex usage provider unavailable')));
      child.stdout.on('error', () => finish(new Error('Codex usage provider unavailable')));
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) return finish(new Error('Codex usage provider returned an oversized response'));
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          let message; try { message = JSON.parse(line); } catch { continue; }
          const entry = pending.get(String(message.id)); if (!entry) continue;
          pending.delete(String(message.id));
          if (message.error) entry.decline(new Error(message.error.message || 'Codex usage read failed'));
          else entry.accept(message.result);
        }
      });
      child.once('error', error => finish(error));
      child.once('exit', () => { if (!settled) finish(new Error('Codex usage provider unavailable')); });
      (async () => {
        try {
          await request('initialize', { clientInfo: { name: 'rin-chat', title: 'Rin chat', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } });
          const [limits, account] = await Promise.all([
            request('account/rateLimits/read', undefined),
            // Identity is optional presentation metadata. Quota reading remains
            // usable on app-server versions that do not expose account/read.
            request('account/read', undefined).catch(() => null),
          ]);
          finish(null, account && typeof account === 'object' ? { ...limits, account } : limits);
        } catch (error) { finish(error); }
      })();
    });
  } };
}

export async function migrateLegacyCostHistory({ dataDir, legacyDbPath, spawnImpl = spawn } = {}) {
  if (!dataDir || !legacyDbPath) throw new Error('dataDir and legacyDbPath are required');
  const query = "SELECT strftime('%Y-%m-%d', timestamp, 'localtime') AS date, SUM(cost_total) AS cost_total, SUM(total_tokens) AS total_tokens, COUNT(*) AS rows FROM telemetry_events WHERE timestamp IS NOT NULL AND cost_total IS NOT NULL GROUP BY date ORDER BY date";
  const output = await new Promise((resolve, reject) => {
    const child = spawnImpl('sqlite3', ['-readonly', '-json', legacyDbPath, query], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`legacy usage migration failed${stderr ? `: ${stderr.trim()}` : ''}`)));
  });
  let rows;
  try { rows = JSON.parse(output); } catch { throw new Error('legacy usage migration returned invalid JSON'); }
  const points = Array.isArray(rows) ? rows.filter(row => typeof row?.date === 'string' && Number.isFinite(Number(row.cost_total)) && Number(row.cost_total) >= 0).map(row => ({ date: row.date, cost_total: Number(row.cost_total), total_tokens: Number(row.total_tokens) || 0, rows: Number(row.rows) || 0 })) : [];
  const directory = join(dataDir, 'usage');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = costHistoryPath(dataDir);
  // The copied JSON is independent of old Rin. This function never writes to its source DB.
  await writeFile(destination, JSON.stringify({ version: 1, source: 'legacy-rin-usage-db', migratedAt: new Date().toISOString(), points }, null, 2), { mode: 0o600 });
  return { path: destination, points: points.length };
}

export async function executeUsage(args = '', { config = {}, dataDir, provider, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('usage dataDir required');
  let options;
  try { options=parseUsageArgs(args); }
  catch(error) { return { text: `${error instanceof Error?error.message:String(error)}\n\n${usageHelp()}` }; }
  if (options.mode === 'help') return { text: usageHelp() };
  if (options.mode === 'legacy-tokens') return { text: `旧 token telemetry 不可用：它依赖已移除的 Pi 事件流和旧数据库。请使用 /usage history 查看 Rin 新记录的额度快照。\n\n${usageHelp()}` };
  if (options.mode === 'history') {
    const rows = await readHistory(dataDir, options.days, now());
    if (!options.json) return { text: renderHistory(rows, options.days) };
    const directory = join(dataDir, 'usage', 'reports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `history-${new Date(now()).toISOString().replace(/[^0-9A-Za-z]/g,'')}.json`);
    await writeFile(path, JSON.stringify({ days: options.days, snapshots: rows }, null, 2), { mode: 0o600 });
    return { text: rows.length ? `已导出最近 ${options.days} 天的 ${rows.length} 次额度快照。` : `最近 ${options.days} 天的历史数据 unknown；已导出空报告。`, files: [{ path, name: basename(path), mimeType: 'application/json' }] };
  }
  const source = provider || createCodexUsageProvider({ config });
  const snapshot = normalizeUsageResponse(await source.readRateLimits(), now());
  if (config.legacyUsageDbPath) {
    try { await readFile(costHistoryPath(dataDir)); }
    catch (error) { if (error?.code === 'ENOENT') await migrateLegacyCostHistory({ dataDir, legacyDbPath: config.legacyUsageDbPath }); else throw error; }
  }
  const trend = await readCostTrend(dataDir);
  await appendSnapshot(dataDir, { observedAt: snapshot.observedAt, limits: snapshot.limits });
  const text = `${renderCurrentUsage(snapshot)}${trend ? `\n\nUSD-equivalent 历史：${trend.days} 天实际记录。` : '\n\nUSD-equivalent 历史 unknown：尚无完整的实际成本快照，未绘制曲线。'}`;
  if (options.mode === 'text') return { text };
  try { return { files: [await writeCard(dataDir, snapshot, trend)], fallbackText: text }; }
  catch { return { text: `${text}\n\n额度卡片生成失败，以上为完整文字结果。` }; }
}
