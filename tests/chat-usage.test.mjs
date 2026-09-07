import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCodexUsageProvider, executeUsage, parseUsageArgs, renderNativeUsageText, buildNativeUsageSeries} from '../dist/chat/usage.js';
import {renderNativeUsageSvg} from '../dist/chat/usage-card.js';
const now=new Date('2026-09-07T14:30:00Z');
const snapshot={account:{account:{email:'owner<&@example.test',planType:'pro'}},rateLimits:{rateLimitsByLimitId:{codex:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:null}},spark:{limitName:'Spark',primary:{usedPercent:10,windowDurationMins:10080,resetsAt:2000000000}}},rateLimitResetCredits:{availableCount:2}},usage:{summary:{lifetimeTokens:999,peakDailyTokens:888,currentStreakDays:0,longestStreakDays:10,longestRunningTurnSec:720},dailyUsageBuckets:[{startDate:'2026-09-05',tokens:5},{startDate:'2026-09-06',tokens:7},{startDate:'2026-09-07',tokens:11}]}};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'rin-usage-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('native views parse and obsolete local-statistics flags fail clearly',()=>{
  assert.deepEqual(parseUsageArgs(''),{view:'daily',text:false,help:false});
  assert.equal(parseUsageArgs('weekly --text').view,'weekly');
  assert.equal(parseUsageArgs('current').text,true);
  assert.equal(parseUsageArgs('cumulative').view,'cumulative');
  for(const args of ['history','--days 7','daily weekly','nope'])assert.throws(()=>parseUsageArgs(args),/不支持/);
});
test('native provider uses only read methods, keeps partial failures and disconnects',async()=>{
  const calls=[];let stops=0;
  const server={start(){},async connect(){},async request(method,args){calls.push([method,args]);if(method==='account/usage/read')throw Error('unavailable');return method==='account/read'?snapshot.account:snapshot.rateLimits;},async stop(){stops++;}};
  const result=await createCodexUsageProvider({server}).read();
  assert.equal(result.usage,null);assert.deepEqual(result.rateLimits,snapshot.rateLimits);assert.equal(stops,1);
  assert.deepEqual(calls,[['account/read',{refreshToken:false}],['account/rateLimits/read',{}],['account/usage/read',{}]]);
  server.request=async()=>{throw Error('offline');};
  await assert.rejects(()=>createCodexUsageProvider({server}).read(),/暂不可用/);assert.equal(stops,2);
});
test('weekly buckets start Sunday; cumulative activity does not replace native lifetime summary',()=>{
  const series=buildNativeUsageSeries(snapshot.usage,now);
  assert.equal(series.weeks.at(-2).tokens,5);assert.deepEqual(series.weeks.at(-1),{date:'2026-09-06',tokens:18,cumulative:23});
  const text=renderNativeUsageText(snapshot,'cumulative',now);
  assert.match(text,/Lifetime 999/);assert.match(text,/2026-09-06: 23 tokens/);assert.match(text,/Spark Weekly limit: 90% left/);
  assert.equal(buildNativeUsageSeries(null,now),null);
  assert.equal(buildNativeUsageSeries({...snapshot.usage,dailyUsageBuckets:[]},now).weeks.at(-1).cumulative,0);
});
test('text does not write a statistics database; cards are PNG presentation artifacts',async t=>{
  const dataDir=await fixture(t),options={dataDir,provider:{read:async()=>snapshot},now:()=>now};
  const text=await executeUsage('text',options);assert.match(text.text,/80% left/);assert.deepEqual(await readdir(dataDir),[]);
  for(const view of ['daily','weekly','cumulative']){
    const card=await executeUsage(view,options);assert.equal(card.text,undefined);assert.match(card.fallbackText,/Lifetime 999/);
    assert.deepEqual([...await readFile(card.files[0].path)].slice(0,8),[137,80,78,71,13,10,26,10]);
    const svg=renderNativeUsageSvg(snapshot,{view,now});assert.match(svg,/owner&lt;&amp;@example.test/);assert.doesNotMatch(svg,/NaN|Infinity/);
  }
  assert.deepEqual(await readdir(join(dataDir,'usage')),['cards']);
});
test('unavailable metrics stay unavailable instead of becoming zeros',()=>{
  const empty={account:null,rateLimits:null,usage:null};
  const text=renderNativeUsageText(empty,'daily',now);assert.match(text,/Lifetime —/);assert.match(text,/Token activity unavailable/);
  assert.match(renderNativeUsageSvg(empty,{now}),/Token activity unavailable/);
});
