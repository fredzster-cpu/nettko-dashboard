import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/';
const url=`${SOURCE}#tilknyttet-kapasitet`;
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=(rows,area)=>{const a=rows.filter(r=>r.area===area);return {cases:a.length,mw:a.reduce((s,r)=>s+(r.mw||0),0)}};

const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
if(!current.queue?.length) throw new Error('Kødata mangler – kan ikke bygge sikker stasjon→prisområde-mapping');

// Build a station→price-area map only from datasets where Statnett publishes explicit Prisområde.
const stationAreas=new Map();
for(const key of ['queue','reservations','withdrawn']){
  for(const r of current[key]||[]){
    if(!r.station || !['NO1','NO5'].includes(r.area)) continue;
    const prev=stationAreas.get(r.station);
    if(prev && prev!==r.area) stationAreas.set(r.station,'CONFLICT');
    else if(!prev) stationAreas.set(r.station,r.area);
  }
}
for(const [s,a] of [...stationAreas]) if(a==='CONFLICT') stationAreas.delete(s);

// Verified overrides for stations that can be absent from the current queue/reservation snapshots.
const stationOverrides=new Map([
  ['Flesaker TRA','NO1']
]);

function inferArea(areaPlan='',station=''){
  if(stationOverrides.has(station)) return {area:stationOverrides.get(station),method:'station_override'};
  if(stationAreas.has(station)) return {area:stationAreas.get(station),method:'station_reference'};
  const p=String(areaPlan).trim();
  const no1=new Set(['Oslo, Akershus og Østfold','Innlandet','Hallingdal og Ringerike']);
  const no5=new Set(['Bergen og Haugalandet','Sogn og Sunnmøre']);
  if(no1.has(p)) return {area:'NO1',method:'area_plan_safe'};
  if(no5.has(p)) return {area:'NO5',method:'area_plan_safe'};
  return {area:null,method:'unresolved'};
}

const browser=await chromium.launch({headless:true});
async function openFresh(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(18000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
  return {context,page};
}
async function reportFrame(page){
  for(let round=0;round<40;round++){
    let candidate=null;
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:3500}).catch(()=>'');
      if(t.includes('Se liste over saker med tilknyttet kapasitet')) return f;
      if(t.includes('Tilknyttet kapasitet')) candidate=f;
    }
    if(candidate) return candidate;
    await page.waitForTimeout(1000);
  }
  return null;
}
async function clickList(frame,page){
  const text='Se liste over saker med tilknyttet kapasitet';
  const candidates=[frame.getByText(text,{exact:false}),frame.getByRole('button',{name:/tilknyttet kapasitet/i}),frame.getByRole('link',{name:/tilknyttet kapasitet/i})];
  for(const loc of candidates){try{if(!(await loc.count()))continue;const el=loc.first();await el.scrollIntoViewIfNeeded().catch(()=>{});await el.click({timeout:15000,force:true});await page.waitForTimeout(3500);return true}catch{}}
  return false;
}
async function detailReady(frame,page){
  for(let round=0;round<45;round++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    const n=await grids.count().catch(()=>0);
    for(let i=0;i<n;i++){
      const t=await grids.nth(i).innerText({timeout:2500}).catch(()=>'');
      if(t.includes('Næringstype')&&t.includes('Områdeplan')&&t.includes('Tilknyttet kapasitet totalt')) return true;
    }
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
async function collect(grid,page){await scroll(grid,true);await page.waitForTimeout(500);const u=new Map();let stale=0,bottom=0;for(let step=0;step<500;step++){const rs=await visibleRows(grid),before=u.size;for(const r of rs)u.set(r.join('|'),r);stale=u.size===before?stale+1:0;const s=await scroll(grid,false);bottom=s.bottom?bottom+1:0;if(!s.moved){try{await grid.press('PageDown')}catch{}}await page.waitForTimeout(220);if(bottom>=3&&stale>=3)break;if(stale>=25)break}return [...u.values()]}

function parse(rows){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));if(!h)return {data:[],unresolved:[],methods:{}};
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  const iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  if([iIndustry,iMw].some(i=>i<0))return {data:[],unresolved:[],methods:{}};
  const data=[],unresolved=[],methods={};
  for(const r of rows.filter(r=>r!==h)){
    const industry=r[iIndustry]||null, mw=num(r[iMw]); if(mw==null||productionTypes.has(industry)) continue;
    const station=iStation>=0?r[iStation]||null:null, areaPlan=iPlan>=0?r[iPlan]||null:null;
    const inferred=inferArea(areaPlan,station); methods[inferred.method]=(methods[inferred.method]||0)+1;
    const row={id:(r[iCase]||r[iTilko]||`Tilknyttet-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station,area_plan:areaPlan,area:inferred.area,area_method:inferred.method,grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett'};
    if(['NO1','NO5'].includes(row.area)) data.push(row); else unresolved.push(row);
  }
  return {data,unresolved,methods};
}

let best=null,lastError=null;
for(let attempt=1;attempt<=4;attempt++){
  const {context,page}=await openFresh();
  try{
    console.log(`Tilknyttet kapasitet v2: forsøk ${attempt}/4`);
    const frame=await reportFrame(page);if(!frame)throw new Error('riktig Power BI-frame ikke funnet');
    let ready=await detailReady(frame,page);if(!ready){await clickList(frame,page);ready=await detailReady(frame,page)}
    if(!ready)throw new Error('detaljtabell ikke funnet');
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]'),gc=await grids.count();const candidates=[],diag=[];
    for(let i=0;i<gc;i++){const rows=await collect(grids.nth(i),page),parsed=parse(rows);diag.push({grid:i,rows:rows.length,parsed:parsed.data.length,unresolved:parsed.unresolved.length,methods:parsed.methods,sample_unresolved:parsed.unresolved.slice(0,12)});candidates.push(parsed)}
    candidates.sort((a,b)=>b.data.length-a.data.length);best=candidates[0]||{data:[],unresolved:[],methods:{}};
    const data=best.data,mw=data.reduce((s,r)=>s+r.mw,0),t1=total(data,'NO1'),t5=total(data,'NO5');
    await fs.writeFile(path.join(RAW,`connected-${day}-v2-diagnostic.json`),JSON.stringify({updated_at:now,url,attempt,station_reference_count:stationAreas.size,cases:data.length,mw,NO1:t1,NO5:t5,unresolved_count:best.unresolved.length,methods:best.methods,diag},null,2));
    if(data.length<1||mw<1||t1.cases<1||t5.cases<1)throw new Error(`ufullstendig uttrekk (${data.length} saker / ${mw} MW)`);
    // Known benchmark from Statnett dashboard on 19.08.2026: NO1 connected total is 296 MW.
    if(day==='2026-08-19' && Math.abs(t1.mw-296)>0.01) throw new Error(`NO1 kontrollsum avviker fra Statnett: ${t1.mw} MW mot 296 MW`);
    await context.close();break;
  }catch(e){lastError=e;best=null;console.error(`Tilknyttet kapasitet v2: ${e.message}`);await page.screenshot({path:path.join(RAW,`connected-${day}-v2-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(2500*attempt)}
}
if(!best){await browser.close();throw lastError||new Error('ingen gyldige data');}

const data=best.data;
current.connected=data;current.status_meta ||= {};current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:best.methods};current.totals ||= {};current.totals.connected={NO1:total(data,'NO1'),NO5:total(data,'NO5')};current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=current.totals.connected.NO1.mw;point.connected_NO5=current.totals.connected.NO5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
console.log('TILKNYTTET KAPASITET V2 VALIDERT');console.log(JSON.stringify(current.totals.connected));await browser.close();
