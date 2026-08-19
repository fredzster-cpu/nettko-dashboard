import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const SNAP = path.join(DATA, 'snapshots');
await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(SNAP, { recursive: true });

const SOURCE = 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/';
const now = new Date().toISOString();
const day = now.slice(0, 10);
const productionTypes = new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: 'nb-NO', viewport: { width: 1920, height: 1400 } });
const page = await context.newPage();
await page.goto(SOURCE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);

function n(s){ if(s==null||s==='') return null; const x=Number(String(s).replace(/\s/g,'').replace(',','.')); return Number.isFinite(x)?x:null; }
function total(rows, area){ const r=rows.filter(x=>x.area===area); return {cases:r.length,mw:r.reduce((a,x)=>a+(x.mw||0),0)}; }
function keyRow(r){ return r.join('|'); }

async function clickList(frame, text){
  const locators=[frame.getByText(text,{exact:false}),frame.getByRole('button',{name:new RegExp(text,'i')}),frame.getByRole('link',{name:new RegExp(text,'i')})];
  for(const loc of locators){ try{ if(await loc.count()){ await loc.first().scrollIntoViewIfNeeded(); await loc.first().click({timeout:15000,force:true}); return true; } }catch{} }
  return false;
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]');
  const count=await rows.count();
  const out=[];
  for(let i=0;i<count;i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const clean=cells.map(x=>x.replace(/\s+/g,' ').trim());
    if(clean.some(Boolean)) out.push(clean);
  }
  return out;
}

async function scrollGrid(grid){
  return await grid.evaluate(el=>{
    let root=el; for(let i=0;i<4&&root.parentElement;i++) root=root.parentElement;
    const nodes=[root,...root.querySelectorAll('*')];
    const candidates=nodes.filter(x=>x.scrollHeight>x.clientHeight+25 && x.clientHeight>40);
    candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
    const s=candidates[0];
    if(!s) return {moved:false,bottom:true};
    const before=s.scrollTop;
    const max=s.scrollHeight-s.clientHeight;
    s.scrollTop=Math.min(max,before+Math.max(180,s.clientHeight*.82));
    s.dispatchEvent(new Event('scroll',{bubbles:true}));
    return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3,before,after:s.scrollTop,max};
  }).catch(()=>({moved:false,bottom:false}));
}

async function collectAllRows(grid){
  const unique=new Map();
  let stale=0;
  try{ await grid.click({position:{x:20,y:40},force:true,timeout:3000}); }catch{}
  for(let step=0;step<180;step++){
    const rows=await visibleRows(grid);
    const before=unique.size;
    for(const r of rows) unique.set(keyRow(r),r);
    stale=unique.size===before?stale+1:0;
    const scroll=await scrollGrid(grid);
    if(!scroll.moved){
      try{ await grid.press('PageDown'); }catch{}
    }
    await page.waitForTimeout(180);
    if((scroll.bottom&&stale>=3)||stale>=10) break;
  }
  return [...unique.values()];
}

function parseGrid(rows,status){
  const header=rows.find(r=>r.some(x=>x.includes('Prisområde')) && r.some(x=>x.includes('(MW)')));
  if(!header) return [];
  const idx=(needle)=>header.findIndex(h=>h.toLowerCase().includes(needle.toLowerCase()));
  const iCase=idx('Statnett saksnr'); const iTilko=idx('Tilko saksnr'); const iStation=idx('Stasjon for tilknytning');
  const iPlan=idx('Områdeplan'); const iArea=idx('Prisområde'); const iCustomer=idx('Statnetts kunde'); const iEnd=idx('Sluttkunde');
  const iIndustry=idx('Næringstype'); const iMw=header.findIndex(h=>h.includes('(MW)')); const iDate=header.findIndex(h=>h.toLowerCase().includes('dato'));
  if([iArea,iEnd,iIndustry,iMw].some(i=>i<0)) return [];
  return rows.filter(r=>r!==header && r[iArea] && /^NO\d$/i.test(r[iArea])).map(r=>({
    id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),
    statnett_case:iCase>=0?r[iCase]||null:null, tilko_case:iTilko>=0?r[iTilko]||null:null,
    station:iStation>=0?r[iStation]||null:null, area_plan:iPlan>=0?r[iPlan]||null:null, area:r[iArea].toUpperCase(),
    grid_customer:iCustomer>=0?r[iCustomer]||null:null, end_customer:r[iEnd]||null, industry:r[iIndustry]||null,
    mw:n(r[iMw]), date:iDate>=0?r[iDate]||null:null, status, source:'Statnett'
  })).filter(r=>r.mw!=null);
}

async function extractReport({heading,listText,status,key}){
  let frame=null;
  for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
    const text=await f.locator('body').innerText({timeout:15000}).catch(()=>'');
    if(text.includes(heading)&&text.includes(listText)){ frame=f; break; }
  }
  if(!frame) throw new Error(`Fant ikke ${heading}-frame`);
  if(!await clickList(frame,listText)) throw new Error(`Klarte ikke åpne ${heading}-listen`);
  await page.waitForTimeout(8000);

  const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
  const gc=await grids.count();
  const parsed=[]; const diagnostics=[];
  for(let i=0;i<gc;i++){
    const rows=await collectAllRows(grids.nth(i));
    const p=parseGrid(rows,status);
    const productionCount=p.filter(x=>productionTypes.has(x.industry)).length;
    diagnostics.push({grid:i,unique_rows:rows.length,parsed_count:p.length,production_count:productionCount,sample:rows.slice(0,5)});
    parsed.push({rows:p,productionCount});
  }
  parsed.sort((a,b)=>(b.rows.length-b.productionCount)-(a.rows.length-a.productionCount));
  const consumption=(parsed[0]?.rows||[]).filter(x=>!productionTypes.has(x.industry));
  const scoped=consumption.filter(x=>x.area==='NO1'||x.area==='NO5');
  await fs.writeFile(path.join(RAW,`${key}-${day}-diagnostic.json`),JSON.stringify({fetched_at:now,heading,grid_count:gc,diagnostics,selected_count:scoped.length},null,2));
  return scoped;
}

console.log('Henter kapasitetskø...');
const queue=await extractReport({heading:'Kapasitetskø',listText:'Se liste over saker i kapasitetskø',status:'Kapasitetskø',key:'queue'});
console.log(`Kø: ${queue.length} NO1/NO5-saker`);
console.log('Henter reservasjoner...');
const reservations=await extractReport({heading:'Reservasjoner',listText:'Se liste over reservasjoner',status:'Reservert',key:'reservations'});
console.log(`Reservasjoner: ${reservations.length} NO1/NO5-saker`);

const current={updated_at:now,source:'Statnett – offentlige Power BI-lister',source_url:SOURCE,scope:'Forbruk, NO1 og NO5',queue,reservations,totals:{queue:{NO1:total(queue,'NO1'),NO5:total(queue,'NO5')},reservations:{NO1:total(reservations,'NO1'),NO5:total(reservations,'NO5')}}};
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2));
let history=[]; try{ history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf-8')); }catch{}
const point={date:day,updated_at:now,queue_NO1:current.totals.queue.NO1.mw,queue_NO5:current.totals.queue.NO5.mw,reserved_NO1:current.totals.reservations.NO1.mw,reserved_NO5:current.totals.reservations.NO5.mw};
history=history.filter(x=>x.date!==day); history.push(point); history.sort((a,b)=>a.date.localeCompare(b.date));
await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
console.log('Ferdig:',JSON.stringify(current.totals));
await browser.close();
