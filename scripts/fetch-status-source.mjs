import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const key=process.argv[2];
const CONFIGS={
  reservations:{heading:'Reservasjoner',anchor:'reservasjoner',list:'Se liste over reservasjoner',status:'Reservert',minCases:1,minMw:1},
  withdrawn:{heading:'Tilbaketrukket kapasitet',anchor:'tilbaketrukket-kapasitet',list:'Se liste over saker med tilbaketrukket kapasitet',status:'Tilbaketrukket',minCases:1,minMw:1},
  connected:{heading:'Tilknyttet kapasitet',anchor:'tilknyttet-kapasitet',list:'Se liste over saker med tilknyttet kapasitet',status:'Tilknyttet',minCases:1,minMw:1}
};
if(!CONFIGS[key]) throw new Error(`Ukjent status: ${key}`);
const cfg=CONFIGS[key];
const ROOT=process.cwd(),DATA=path.join(ROOT,'data'),RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/';
const url=`${SOURCE}#${cfg.anchor}`;
const now=new Date().toISOString(),day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=(rows,area)=>{const a=rows.filter(r=>r.area===area);return {cases:a.length,mw:a.reduce((s,r)=>s+(r.mw||0),0)}};
const browser=await chromium.launch({headless:true});

// Build a trusted station -> price-area map from already validated Statnett rows.
// This is safer than assuming that an entire Statnett area plan belongs to one price area.
let existing={};
try{existing=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'))}catch{}
const stationAreaVotes=new Map();
for(const datasetKey of ['queue','reservations','withdrawn','connected']){
  for(const r of (existing[datasetKey]||[])){
    if(!r.station || !['NO1','NO5'].includes(r.area)) continue;
    const s=String(r.station).trim();
    if(!stationAreaVotes.has(s)) stationAreaVotes.set(s,{NO1:0,NO5:0});
    stationAreaVotes.get(s)[r.area]++;
  }
}
const stationAreaMap=new Map();
for(const [station,v] of stationAreaVotes){
  if(v.NO1 && !v.NO5) stationAreaMap.set(station,'NO1');
  else if(v.NO5 && !v.NO1) stationAreaMap.set(station,'NO5');
  else if(v.NO1!==v.NO5) stationAreaMap.set(station,v.NO1>v.NO5?'NO1':'NO5');
}

// Only use area plan as fallback when it is unambiguous for our scope.
function inferArea(areaPlan='',station=''){
  const st=String(station||'').trim();
  if(stationAreaMap.has(st)) return stationAreaMap.get(st);
  const p=String(areaPlan).trim();
  const no1=new Set(['Oslo, Akershus og Østfold','Innlandet','Hallingdal og Ringerike']);
  const no5=new Set(['Bergen og Haugalandet','Sogn og Sunnmøre']);
  if(no1.has(p)) return 'NO1';
  if(no5.has(p)) return 'NO5';
  return null;
}

async function openFresh(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(18000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
  return {context,page};
}

async function reportFrame(page){
  for(let round=0;round<40;round++){
    let headingOnly=null;
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:3500}).catch(()=>'');
      if(cfg.list&&t.includes(cfg.list)) return f;
      if(t.includes(cfg.heading)) headingOnly=f;
    }
    if(headingOnly) return headingOnly;
    await page.waitForTimeout(1000);
  }
  return null;
}

async function clickList(frame,page){
  if(!cfg.list) return false;
  const re=new RegExp(cfg.list.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  const candidates=[frame.getByText(cfg.list,{exact:false}),frame.getByRole('button',{name:re}),frame.getByRole('link',{name:re})];
  for(const loc of candidates){
    try{if(!(await loc.count()))continue;const el=loc.first();await el.scrollIntoViewIfNeeded().catch(()=>{});await el.click({timeout:15000,force:true});await page.waitForTimeout(3500);return true}catch{}
  }
  return false;
}

async function detailReady(frame,page){
  for(let round=0;round<45;round++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    const n=await grids.count().catch(()=>0);
    for(let i=0;i<n;i++){
      const t=await grids.nth(i).innerText({timeout:2500}).catch(()=>'');
      if((t.includes('Prisområde')||t.includes('Områdeplan'))&&(t.includes('(MW)')||t.includes('Næringstype'))) return true;
    }
    const body=await frame.locator('body').innerText({timeout:2500}).catch(()=>'');
    if((body.includes('Prisområde')||body.includes('Områdeplan'))&&body.includes('Næringstype')&&(body.includes('Sluttkunde')||body.includes('Statnett saksnr'))) return true;
    await page.waitForTimeout(900);
  }
  return false;
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]'),n=await rows.count(),out=[];
  for(let i=0;i<n;i++){const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);const c=cells.map(x=>x.replace(/\s+/g,' ').trim());if(c.some(Boolean))out.push(c)}
  return out;
}
async function scroll(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=c[0];if(!s)return {moved:false,bottom:true};if(reset){s.scrollTop=0;return {moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65));s.dispatchEvent(new Event('scroll',{bubbles:true}));return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}
async function collect(grid,page){await scroll(grid,true);await page.waitForTimeout(500);const u=new Map();let stale=0,bottom=0;for(let step=0;step<450;step++){const rs=await visibleRows(grid),before=u.size;for(const r of rs)u.set(r.join('|'),r);stale=u.size===before?stale+1:0;const s=await scroll(grid,false);bottom=s.bottom?bottom+1:0;if(!s.moved){try{await grid.press('PageDown')}catch{}}await page.waitForTimeout(230);if(bottom>=3&&stale>=3)break;if(stale>=22)break}return [...u.values()]}

function parse(rows){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.includes('(MW)'))&&(r.some(x=>x.includes('Prisområde'))||r.some(x=>x.includes('Områdeplan'))));if(!h)return {data:[],unresolved:[]};
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype');
  let iMw=h.findIndex(x=>x.includes('(MW)'));
  if(key==='connected'){
    const totalMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
    if(totalMw>=0)iMw=totalMw;
  }
  const iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  if([iIndustry,iMw].some(i=>i<0))return {data:[],unresolved:[]};
  const data=[],unresolved=[];
  for(const r of rows.filter(r=>r!==h)){
    const industry=r[iIndustry]||null,mw=num(r[iMw]);
    if(mw==null || productionTypes.has(industry)) continue;
    const station=iStation>=0?r[iStation]||null:null,plan=iPlan>=0?r[iPlan]||null:null;
    const explicit=iArea>=0?(r[iArea]||'').toUpperCase():null;
    const area=['NO1','NO5'].includes(explicit)?explicit:inferArea(plan,station);
    const row={id:(r[iCase]||r[iTilko]||`${cfg.status}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station,area_plan:plan,area,grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry,mw,date:iDate>=0?r[iDate]||null:null,status:cfg.status,source:'Statnett'};
    if(area==='NO1'||area==='NO5') data.push(row);
    else unresolved.push(row);
  }
  return {data,unresolved};
}

let data=null,lastError=null;
for(let attempt=1;attempt<=4;attempt++){
  const {context,page}=await openFresh();
  try{
    console.log(`${cfg.heading} kildehenter: forsøk ${attempt}/4`);
    const frame=await reportFrame(page);if(!frame)throw new Error('riktig Power BI-frame ikke funnet');
    let ready=await detailReady(frame,page);
    if(!ready){const clicked=await clickList(frame,page);if(clicked)ready=await detailReady(frame,page)}
    if(!ready)throw new Error('detaljtabell ikke funnet i riktig rapport');
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]'),gc=await grids.count();
    const candidates=[],diag=[];
    for(let i=0;i<gc;i++){
      const rows=await collect(grids.nth(i),page),parsed=parse(rows);
      diag.push({grid:i,rows:rows.length,parsed:parsed.data.length,unresolved:parsed.unresolved.length,unresolved_mw:parsed.unresolved.reduce((s,x)=>s+x.mw,0),unresolved_sample:parsed.unresolved.slice(0,10),sample:rows.slice(0,4)});
      candidates.push(parsed);
    }
    candidates.sort((a,b)=>b.data.length-a.data.length);const best=candidates[0]||{data:[],unresolved:[]};data=best.data;
    const unresolved=best.unresolved,mw=data.reduce((s,r)=>s+r.mw,0),t1=total(data,'NO1'),t5=total(data,'NO5');
    await fs.writeFile(path.join(RAW,`${key}-${day}-source-diagnostic.json`),JSON.stringify({updated_at:now,url,attempt,frame_url:frame.url(),grid_count:gc,cases:data.length,mw,NO1:t1,NO5:t5,unresolved_cases:unresolved.length,unresolved_mw:unresolved.reduce((s,x)=>s+x.mw,0),unresolved,station_area_map_size:stationAreaMap.size,diag},null,2));
    // Never silently discard consumption MW because price-area classification failed.
    if(unresolved.length) throw new Error(`uavklarte prisområder: ${unresolved.length} saker / ${unresolved.reduce((s,x)=>s+x.mw,0)} MW`);
    if(data.length<cfg.minCases||mw<cfg.minMw||!(t1.cases>0||t5.cases>0))throw new Error(`ufullstendig uttrekk (${data.length} saker / ${mw} MW)`);
    console.log(`${cfg.heading}: ${data.length} saker, ${mw} MW; NO1 ${t1.cases}/${t1.mw} MW; NO5 ${t5.cases}/${t5.mw} MW`);await context.close();break;
  }catch(e){lastError=e;data=null;console.error(`${cfg.heading}: ${e.message}`);await page.screenshot({path:path.join(RAW,`${key}-${day}-source-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(2500*attempt)}
}
if(!data){await browser.close();throw lastError||new Error('ingen gyldige data');}

const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
if(!current.queue?.length)throw new Error('kødata mangler – avbryter sammenslåing');
current[key]=data;current.status_meta ||= {};current.status_meta[key]={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false};current.totals ||= {};current.totals[key]={NO1:total(data,'NO1'),NO5:total(data,'NO5')};current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point[`${key}_NO1`]=current.totals[key].NO1.mw;point[`${key}_NO5`]=current.totals[key].NO5.mw;if(key==='reservations'){point.reserved_NO1=current.totals[key].NO1.mw;point.reserved_NO5=current.totals[key].NO5.mw}history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
console.log(`${cfg.heading.toUpperCase()} VALIDERT VIA STATNETT-SIDEN`);console.log(JSON.stringify(current.totals[key]));await browser.close();