import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deflateSync } from 'node:zlib';

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
    '历史不会导入旧 Rin 数据；没有记录时会明确显示 unknown。',
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
  return { observedAt: new Date(now).toISOString(), limits };
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

const FONT = {
  ' ':['00000','00000','00000','00000','00000','00000','00000'], '+':['00000','00100','00100','11111','00100','00100','00000'], '-':['00000','00000','00000','11111','00000','00000','00000'], '.':['00000','00000','00000','00000','00000','01100','01100'], ':':['00000','01100','01100','00000','01100','01100','00000'], '/':['00001','00010','00010','00100','01000','01000','10000'], '%':['11001','11010','00100','01000','10110','00110','00000'],
  '0':['01110','10001','10011','10101','11001','10001','01110'], '1':['00100','01100','00100','00100','00100','00100','01110'], '2':['01110','10001','00001','00010','00100','01000','11111'], '3':['11110','00001','00001','01110','00001','00001','11110'], '4':['00010','00110','01010','10010','11111','00010','00010'], '5':['11111','10000','10000','11110','00001','00001','11110'], '6':['01110','10000','10000','11110','10001','10001','01110'], '7':['11111','00001','00010','00100','01000','01000','01000'], '8':['01110','10001','10001','01110','10001','10001','01110'], '9':['01110','10001','10001','01111','00001','00001','01110'],
  A:['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'], C:['01110','10001','10000','10000','10000','10001','01110'], D:['11110','10001','10001','10001','10001','10001','11110'], E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'], G:['01110','10001','10000','10111','10001','10001','01110'], H:['10001','10001','10001','11111','10001','10001','10001'], I:['01110','00100','00100','00100','00100','00100','01110'], J:['00111','00010','00010','00010','00010','10010','01100'], K:['10001','10010','10100','11000','10100','10010','10001'], L:['10000','10000','10000','10000','10000','10000','11111'], M:['10001','11011','10101','10101','10001','10001','10001'], N:['10001','11001','10101','10011','10001','10001','10001'], O:['01110','10001','10001','10001','10001','10001','01110'], P:['11110','10001','10001','11110','10000','10000','10000'], Q:['01110','10001','10001','10001','10101','10010','01101'], R:['11110','10001','10001','11110','10100','10010','10001'], S:['01111','10000','10000','01110','00001','00001','11110'], T:['11111','00100','00100','00100','00100','00100','00100'], U:['10001','10001','10001','10001','10001','10001','01110'], V:['10001','10001','10001','10001','01010','01010','00100'], W:['10001','10001','10001','10101','10101','10101','01010'], X:['10001','01010','00100','00100','00100','01010','10001'], Y:['10001','01010','00100','00100','00100','00100','00100'], Z:['11111','00001','00010','00100','01000','10000','11111'],
};

function pngCard(snapshot) {
  const windows = snapshot.limits.flatMap(limit => (limit.windows || []).map(window => ({ limit, window })));
  const credits = snapshot.limits.filter(limit => limit.credits).map(limit => {
    const value = limit.credits.unlimited ? 'UNLIMITED' : limit.credits.hasCredits && limit.credits.balance !== null ? limit.credits.balance : 'NONE';
    return `${limit.name || limit.id} CREDITS ${value}`;
  });
  const width = 1000, headerHeight = 160, rowHeight = 92;
  const contentRows = Math.max(1, windows.length);
  const creditsHeight = credits.length * 34;
  const footerTop = headerHeight + contentRows * rowHeight + creditsHeight;
  const height = footerTop + 64;
  const pixels = Buffer.alloc(width * height * 4);
  const rect = (x, y, w, h, color) => {
    for (let yy = Math.max(0,y); yy < Math.min(height,y+h); yy++) for (let xx = Math.max(0,x); xx < Math.min(width,x+w); xx++) {
      const offset=(yy*width+xx)*4; pixels[offset]=color[0]; pixels[offset+1]=color[1]; pixels[offset+2]=color[2]; pixels[offset+3]=255;
    }
  };
  const draw = (value,x,y,scale,color) => {
    for (const character of String(value).toUpperCase()) {
      const glyph=FONT[character] || FONT[' '];
      glyph.forEach((row,yy)=>[...row].forEach((bit,xx)=>{if(bit==='1')rect(x+xx*scale,y+yy*scale,scale,scale,color);}));
      x+=(glyph[0].length+1)*scale;
    }
  };
  const text=[226,232,240], muted=[148,163,184], panel=[20,29,49], border=[51,65,85], accent=[56,189,248];
  rect(0,0,width,height,[9,14,29]); rect(0,0,width,8,accent);
  draw('CHATGPT CODEX USAGE',44,34,4,text);
  draw('REMAINING QUOTA',46,78,2,muted);
  const plans=[...new Set(snapshot.limits.map(limit=>limit.planType).filter(Boolean))];
  if(plans.length)draw(`PLAN ${plans.join(' / ')}`,46,104,2,accent);
  rect(44,136,width-88,2,border);
  if (!windows.length) {
    rect(44,160,width-88,72,panel);
    draw('CURRENT USAGE UNKNOWN',64,174,2,muted);
  }
  windows.forEach(({limit,window},index)=>{
    const top=160+index*rowHeight, left=window.remainingPercent;
    rect(44,top,width-88,72,panel);
    const mins=window.windowDurationMins;
    const duration=mins===null?'UNKNOWN':mins>0&&mins%1440===0?`${mins/1440}D`:mins>0&&mins%60===0?`${mins/60}H`:`${mins}M`;
    const bucket=limit.name || limit.id;
    const rawTitle=`${bucket} ${duration}`;
    const title=rawTitle.length>25?`${rawTitle.slice(0,22)}...`:rawTitle;
    const color=left===null?muted:left>=60?[74,222,128]:left>=25?[250,204,21]:[251,113,133];
    draw(title,64,top+14,2,text);
    draw(left===null?'UNKNOWN':`${left}% LEFT`,350,top+14,2,color);
    let reset='UNKNOWN';
    if(window.resetsAt!==null){
      const date=new Date(window.resetsAt>1e11?window.resetsAt:window.resetsAt*1000);
      if(!Number.isNaN(date.getTime())){
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
        const part=type=>parts.find(value=>value.type===type)?.value;
        reset=`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
      }
    }
    draw(`RESET ${reset}${reset==='UNKNOWN'?'':' GMT+8'}`,570,top+14,2,muted);
    rect(64,top+47,852,12,border);
    if(left!==null)rect(64,top+47,Math.round(852*left/100),12,color);
  });
  credits.forEach((value,index)=>draw(value.length>70?`${value.slice(0,67)}...`:value,48,headerHeight+contentRows*rowHeight+16+index*34,2,text));
  rect(44,footerTop+12,width-88,2,border);
  draw('CODEX QUOTA - ASIA/SHANGHAI',46,footerTop+32,2,muted);
  const crc32=input=>{let crc=0xffffffff;for(const byte of input){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const name=Buffer.from(type),body=Buffer.concat([name,data]),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);body.copy(out,4);out.writeUInt32BE(crc32(body),data.length+8);return out;};
  const raw=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++){const at=y*(width*4+1);raw[at]=0;pixels.copy(raw,at+1,y*width*4,(y+1)*width*4);}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

async function writeCard(dataDir, snapshot) {
  const directory = join(dataDir, 'usage', 'cards');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `codex-usage-${snapshot.observedAt.replace(/[^0-9A-Za-z]/g, '')}.png`);
  await writeFile(path, pngCard(snapshot), { mode: 0o600 });
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
          finish(null, await request('account/rateLimits/read', undefined));
        } catch (error) { finish(error); }
      })();
    });
  } };
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
  await appendSnapshot(dataDir, snapshot);
  const text = renderCurrentUsage(snapshot);
  if (options.mode === 'text') return { text };
  try { return { files: [await writeCard(dataDir, snapshot)], fallbackText: text }; }
  catch { return { text: `${text}\n\n额度卡片生成失败，以上为完整文字结果。` }; }
}
