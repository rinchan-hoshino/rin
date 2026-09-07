import {Resvg} from '@resvg/resvg-js';
import {buildNativeUsageSeries,compactTokens,nativeLimitRows,nativeResetLabel,nativeSummaryLine} from './usage.js';
import type {NativeUsageSnapshot,UsageView} from './usage.js';

const W=1440,ink='#344850',muted='#788d94',teal='#229c97',cream='#fff9e8',line='#e4dbc4',accent='#e5a457';
const escape=(value: unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const text=(x:number,y:number,value:unknown,size=21,color=ink,extra='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${escape(value)}</text>`;
const rect=(x:number,y:number,w:number,h:number,color:string,r=0)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${color}"/>`;
const month=(date:string)=>new Intl.DateTimeFormat('en',{month:'short',timeZone:'UTC'}).format(new Date(`${date}T00:00:00Z`));

/** Native status rows and activity views, with typography and color only. */
export function renderNativeUsageSvg(snapshot: NativeUsageSnapshot,{view='daily',now=new Date()}: {view?:UsageView;now?:Date} = {}) {
  const limits=nativeLimitRows(snapshot),account=snapshot.account?.account;
  const statusHeight=142+Math.max(1,limits.length)*54+(snapshot.rateLimits?.rateLimitResetCredits?34:0);
  const activityY=50+statusHeight+62;
  const chartHeight=view==='daily'?264:284;
  const H=activityY+125+chartHeight+122;
  const svg=[`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,rect(0,0,W,H,cream),
    '<g font-family="Menlo,Consolas,DejaVu Sans Mono,monospace">',
    `<rect x="40" y="36" width="1360" height="${statusHeight}" rx="12" fill="none" stroke="${line}" stroke-width="2"/>`,
    text(66,81,'/status',26,teal,'font-weight="bold"'),
    text(1374,81,'CODEX',18,muted,'text-anchor="end"'),
    text(66,126,'Account:',22),text(220,126,`${account?.email || account?.type || '—'}${account?.planType?` (${account.planType})`:''}`,22,muted),
  ];
  limits.forEach((row,index)=>{
    const y=180+index*54;
    svg.push(text(66,y,row.label,20),rect(590,y-17,300,19,'#ebe6d7',3));
    if(row.percentLeft!=null)svg.push(rect(590,y-17,300*row.percentLeft/100,19,teal,3));
    svg.push(text(918,y,row.percentLeft==null?'—':`${Math.round(row.percentLeft)}% left`,20),text(1374,y,`resets ${nativeResetLabel(row.resetAt)}`,18,muted,'text-anchor="end"'));
  });
  if(!limits.length)svg.push(text(66,180,'Rate limits unavailable',20,muted));
  const resets=snapshot.rateLimits?.rateLimitResetCredits?.availableCount;
  if(resets!=null)svg.push(text(66,50+statusHeight-23,`${resets} usage limit resets available`,18,muted));
  svg.push(text(58,activityY,`/usage ${view}`,26,teal,'font-weight="bold"'),text(58,activityY+48,'Token activity',24),text(305,activityY+48,'last 12 months',20,muted),text(58,activityY+85,nativeSummaryLine(snapshot.usage),19,muted));
  const series=buildNativeUsageSeries(snapshot.usage,now),chartY=activityY+138;
  if(!series)svg.push(text(58,chartY+70,'Token activity unavailable',22,muted));
  else if(view==='daily') {
    const left=137,step=23,cell=17;
    ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach((day,index)=>svg.push(text(69,chartY+index*27+14,day,18,muted)));
    const max=Math.max(1,...series.days.map(day=>day.tokens));
    const palette=['#fcf3d9','#f6df9d','#edc568','#e8ad47','#cb8f2d'];
    let lastMonth='';
    series.weeks.forEach((week,index)=>{
      const label=month(week.date);
      if(label!==lastMonth && index>0){svg.push(text(left+index*step,chartY-19,label,17,muted));lastMonth=label;}
    });
    series.days.forEach((day,index)=>{
      const x=left+Math.floor(index/7)*step,y=chartY+(index%7)*27;
      const level=day.tokens===0?0:Math.min(4,Math.max(1,Math.ceil(day.tokens/max*4)));
      svg.push(rect(x,y,cell,cell,palette[level],2));
      if(!day.tokens)svg.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="none" stroke="${line}"/>`);
    });
    svg.push(text(69,chartY+224,'Less',17,muted));palette.forEach((color,i)=>svg.push(rect(131+i*27,chartY+210,17,17,color,2)));svg.push(text(277,chartY+224,'More',17,muted));
  } else {
    const left=137,width=1205,height=190,values=series.weeks.map(week=>view==='weekly'?week.tokens:week.cumulative),max=Math.max(1,...values);
    svg.push(text(66,chartY+15,compactTokens(Math.max(0,...values)),17,muted),text(95,chartY+height+3,'0',17,muted));
    svg.push(`<path d="M ${left} ${chartY} H ${left+width} M ${left} ${chartY+height} H ${left+width}" stroke="${line}" stroke-width="1"/>`);
    let lastMonth='';const step=width/Math.max(1,values.length);
    values.forEach((value,index)=>{
      const barHeight=value/max*height;
      if(value>0)svg.push(rect(left+index*step,chartY+height-barHeight,Math.max(1,step-7),barHeight,view==='weekly'?accent:teal,2));
      const label=month(series.weeks[index].date);
      if(label!==lastMonth && index>0){svg.push(text(left+index*step,chartY+height+30,label,16,muted));lastMonth=label;}
    });
    svg.push(text(69,chartY+height+68,view==='weekly'?`Each column = 1 week · tallest ${compactTokens(Math.max(0,...values))}`:`Running total · top ${compactTokens(Math.max(0,...values))}`,18,muted));
  }
  const footerY=H-74;
  ['daily','weekly','cumulative'].forEach((name,index)=>svg.push(text(69+[0,112,235][index],footerY,name,20,name===view?teal:muted,name===view?'font-weight="bold"':'')));
  svg.push(text(69,H-30,'Codex native usage',15,muted),text(1371,H-30,`${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(now)} · UTC+08:00`,15,muted,'text-anchor="end"'));
  return svg.join('')+'</g></svg>';
}
export function renderNativeUsagePng(snapshot: NativeUsageSnapshot,options: {view?:UsageView;now?:Date} = {}): Buffer {
  return Buffer.from(new Resvg(renderNativeUsageSvg(snapshot,options),{font:{loadSystemFonts:true,defaultFontFamily:'Menlo'}}).render().asPng());
}
