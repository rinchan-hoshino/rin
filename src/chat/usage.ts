import {mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodexAppServer} from '../codex-app-server.js';
import type {CodexConfig, ChatOutput} from './types.js';
import {renderNativeUsagePng} from './usage-card.js';

export type UsageView = 'daily' | 'weekly' | 'cumulative';
export interface NativeUsage {
  summary: {lifetimeTokens: number | null; peakDailyTokens: number | null; longestRunningTurnSec: number | null; currentStreakDays: number | null; longestStreakDays: number | null};
  dailyUsageBuckets: {startDate: string; tokens: number}[] | null;
}
export interface NativeLimitWindow {usedPercent: number; windowDurationMins: number | null; resetsAt: number | null;}
export interface NativeLimit {
  limitId?: string | null; limitName?: string | null; planType?: string | null;
  primary?: NativeLimitWindow | null; secondary?: NativeLimitWindow | null;
  credits?: {hasCredits: boolean; unlimited: boolean; balance: string | null} | null;
}
export interface NativeUsageSnapshot {
  account: {account?: {type?: string; email?: string | null; planType?: string | null} | null} | null;
  rateLimits: {rateLimits?: NativeLimit | null; rateLimitsByLimitId?: Record<string, NativeLimit> | null; rateLimitResetCredits?: {availableCount: number} | null} | null;
  usage: NativeUsage | null;
}
export interface UsageProvider {read(): Promise<NativeUsageSnapshot>;}

export function createCodexUsageProvider({config = {}, server}: {config?: CodexConfig; server?: Pick<CodexAppServer, 'start' | 'connect' | 'request' | 'stop'>} = {}): UsageProvider {
  return {async read() {
    const client=server || new CodexAppServer({command:config.command, codexHome:config.codexHome});
    client.start();
    try {
      await client.connect();
      const results=await Promise.allSettled([
        client.request<NativeUsageSnapshot['account']>('account/read',{refreshToken:false}),
        client.request<NativeUsageSnapshot['rateLimits']>('account/rateLimits/read',{}),
        client.request<NativeUsage>('account/usage/read',{}),
      ]);
      // Missing cloud metrics stay missing. Never substitute a local estimate.
      if(results.every(result=>result.status==='rejected'))throw new Error('Codex 原生用量暂不可用。');
      return {account:results[0].status==='fulfilled'?results[0].value:null,
        rateLimits:results[1].status==='fulfilled'?results[1].value:null,
        usage:results[2].status==='fulfilled'?results[2].value:null};
    } finally {await client.stop();}
  }};
}

export function parseUsageArgs(input = ''): {view: UsageView; text: boolean; help: boolean} {
  const words=input.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if(words.includes('--help') || words.includes('-h'))return {view:'daily',text:false,help:true};
  let view: UsageView='daily', text=false, hasView=false;
  for(const word of words) {
    if(['daily','weekly','cumulative'].includes(word) && !hasView){view=word as UsageView;hasView=true;}
    else if(['text','current','--text'].includes(word) && !text)text=true;
    else if(word==='card' && words.length===1)continue;
    else throw new Error(`不支持的参数：${word}`);
  }
  return {view,text,help:false};
}
const HELP='用法：/usage [daily|weekly|cumulative] [--text]\n\n/usage：Codex 原生额度 + 每日活动热力图\n/usage weekly：每周 Token 活动\n/usage cumulative：累计 Token 活动\n/usage text：完整文字结果\n\n数据与 Codex /status、/usage 相同；只美化图片，不另行统计或估算费用。';
export function compactTokens(value: number | null | undefined): string {
  if(value==null || !Number.isFinite(value))return '—';
  for(const [scale,suffix] of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']] as const)
    if(value>=scale)return `${Number((value/scale).toPrecision(3))}${suffix}`;
  return String(Math.round(value));
}
export function nativeLimitRows(snapshot: NativeUsageSnapshot) {
  const response=snapshot.rateLimits;
  const buckets=response?.rateLimitsByLimitId;
  const limits=buckets && Object.keys(buckets).length ? Object.entries(buckets).sort(([a],[b])=>a.localeCompare(b))
    : response?.rateLimits ? [[response.rateLimits.limitId || 'codex',response.rateLimits] as const] : [];
  return limits.flatMap(([id,limit])=>[limit.primary,limit.secondary].filter((w): w is NativeLimitWindow=>Boolean(w)).map(window=>{
    const minutes=window.windowDurationMins;
    const duration=minutes===10080?'Weekly':minutes===300?'5h':minutes!=null?`${minutes}m`:'Usage';
    const label=`${id==='codex'?'':`${limit.limitName || id} `}${duration} limit`;
    return {label,percentLeft:Number.isFinite(window.usedPercent)?Math.max(0,Math.min(100,100-window.usedPercent)):null,resetAt:window.resetsAt};
  }));
}
export function nativeResetLabel(seconds: number | null | undefined) {
  if(seconds==null || !Number.isFinite(seconds))return '—';
  return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(seconds*1000));
}
export function nativeSummaryLine(usage: NativeUsage | null) {
  const s=usage?.summary;
  const minutes=s?.longestRunningTurnSec==null?'—':`${Math.floor(s.longestRunningTurnSec/60)}m`;
  return `Lifetime ${compactTokens(s?.lifetimeTokens)} · Peak ${compactTokens(s?.peakDailyTokens)} · Streak ${s?.currentStreakDays??'—'}d (best ${s?.longestStreakDays??'—'}d) · Longest task ${minutes}`;
}
export function renderNativeUsageText(snapshot: NativeUsageSnapshot, view: UsageView, now = new Date()): string {
  const account=snapshot.account?.account;
  const lines=['Codex /status',`Account: ${account?.email || account?.type || '—'}${account?.planType?` (${account.planType})`:''}`];
  for(const row of nativeLimitRows(snapshot))lines.push(`${row.label}: ${row.percentLeft==null?'—':`${Math.round(row.percentLeft)}% left`} · resets ${nativeResetLabel(row.resetAt)} (UTC+08:00)`);
  if(!snapshot.rateLimits)lines.push('Rate limits unavailable');
  const resets=snapshot.rateLimits?.rateLimitResetCredits?.availableCount;
  if(resets!=null)lines.push(`Usage limit resets available: ${resets}`);
  lines.push('',`Codex /usage ${view} · last 12 months`,nativeSummaryLine(snapshot.usage));
  const series=buildNativeUsageSeries(snapshot.usage,now);
  if(!series)lines.push('Token activity unavailable');
  else if(view==='daily')for(const day of series.days.filter(day=>day.tokens>0))lines.push(`${day.date}: ${day.tokens.toLocaleString('en-US')} tokens`);
  else for(const week of series.weeks.filter(week=>view==='cumulative'?week.cumulative>0:week.tokens>0))lines.push(`${week.date}: ${(view==='cumulative'?week.cumulative:week.tokens).toLocaleString('en-US')} tokens`);
  lines.push('',`Updated ${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(now)} (UTC+08:00)`);
  return lines.join('\n');
}
export function buildNativeUsageSeries(usage: NativeUsage | null, now = new Date()) {
  if(!Array.isArray(usage?.dailyUsageBuckets))return null;
  // Codex's activity grid and weekly view use Sunday-based weeks. Keep the
  // server's calendar dates; do not regroup request timestamps in a new zone.
  const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
  const endSunday=today-new Date(today).getUTCDay()*86400000;
  const start=endSunday-52*7*86400000;
  const buckets=new Map(usage.dailyUsageBuckets.map(row=>[row.startDate,row.tokens]));
  const days=[];
  for(let time=start;time<=today;time+=86400000){const date=new Date(time).toISOString().slice(0,10);days.push({date,tokens:buckets.get(date)||0});}
  let cumulative=0;
  const weeks=[];
  for(let i=0;i<days.length;i+=7){const tokens=days.slice(i,i+7).reduce((sum,day)=>sum+day.tokens,0);cumulative+=tokens;weeks.push({date:days[i].date,tokens,cumulative});}
  return {days,weeks};
}
export async function executeUsage(args = '', {config = {},dataDir,provider,now = ()=>new Date()}: {config?: CodexConfig;dataDir?: string;provider?: UsageProvider;now?: ()=>Date} = {}): Promise<ChatOutput> {
  if(!dataDir)throw new Error('usage dataDir required');
  let options;
  try {options=parseUsageArgs(args);}catch(error){return {text:`${(error as Error).message}\n\n${HELP}`};}
  if(options.help)return {text:HELP};
  let snapshot;
  try {snapshot=await (provider || createCodexUsageProvider({config})).read();}
  catch{return {text:'Codex 原生用量暂不可用，请稍后重试。'};}
  const observed=now(),text=renderNativeUsageText(snapshot,options.view,observed);
  if(options.text)return {text};
  try {
    const directory=join(dataDir,'usage','cards');await mkdir(directory,{recursive:true,mode:0o700});
    const path=join(directory,`native-${observed.getTime()}-${randomUUID()}.png`);
    await writeFile(path,renderNativeUsagePng(snapshot,{view:options.view,now:observed}),{mode:0o600});
    // Card files are presentation artifacts, never a parallel usage database.
    const previous=(await readdir(directory)).filter(name=>name.startsWith('native-') && name.endsWith('.png')).sort().slice(0,-24);
    await Promise.all(previous.map(name=>rm(join(directory,name),{force:true})));
    return {files:[{path,name:basename(path),mimeType:'image/png'}],fallbackText:text};
  } catch {return {text};}
}
