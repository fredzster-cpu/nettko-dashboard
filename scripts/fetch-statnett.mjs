import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw');
const SNAP = path.join(DATA, 'snapshots');
await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(SNAP, { recursive: true });

const SOURCE = 'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8';
const now = new Date().toISOString();
const day = now.slice(0, 10);
const productionTypes = new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'nb-NO',
  viewport: { width: 1920, height: 1400 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36'
});
const page = await context.newPage();
page.setDefaultTimeout(15000);

function n(s){
  if(s==null||s==='') return null;
  const x=Number(String(s).replace(/\s/g,'').replace(',','.'));
  return Number.isFinite(x)?x:null;
}
function total(rows, area){
  const r=rows.filter(x=>x.area===area);
  return {cases:r.length,mw:r.reduce((a,x)=>a+(x.mw||0),0)};
}
function keyRow(r){ return r.join('|'); }
function esc(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
async function sleep(ms){ await page.waitForTimeout(ms); }

async function loadSource(){
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});
  await sleep(10000);
}

async function findReportFrame(heading,listText,timeoutMs=45000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const text=await f.locator('body').innerText({timeout:5000}).catch(()=>'');
      if(text.includes(heading) && (text.includes(listText)||text.includes('Prisområde'))) return f;
    }
    await sleep(1500);
  }
  return null;
}

async function hasDetailGrid(frame){
  const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
  const gc=await grids.count().catch(()=>0);
  for(let i=0;i<gc;i++){
    const text=await grids.nth(i).innerText({timeout:3000}).catch(()=>'');
    if(text.includes('Prisområde') && (text.includes('(MW)')||text.includes('Næringstype'))) return true;
  }
  return false;
}

async function waitForDetailGrid(frame,timeoutMs=18000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await hasDetailGrid(frame)) return true;
    await sleep(800);
  }
  return false;
}

async function clickList(frame,text){
  if(await hasDetailGrid(frame)) return true;
  const re=new RegExp(esc(text),'i');
  const locators=[
    frame.getByRole('button',{name:re}),
    frame.getByRole('link',{name:re}),
    frame.getByText(text,{exact:false}),
    frame.locator(`text=${text}`)
  ];

  for(const loc of locators){
    try{
      if(!(await loc.count())) continue;
      const target=loc.first();
      await target.scrollIntoViewIfNeeded().catch(()=>{});
      for(const options of [{force:false},{force:true}]){
        try{
          await target.click({timeout:8000,...options});
          if(await waitForDetailGrid(frame,12000)) return true;
        }catch{}
      }
    }catch{}
  }

  // Power BI rendrer av og til teksten i et SVG/div-element. Klikk nærmeste
  // interaktive forelder og verifiser at tabellen faktisk åpnet seg.
  const domClicked=await frame.evaluate((targetText)=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim().toLowerCase();
    const wanted=norm(targetText);
    const all=[...document.querySelectorAll('body *')];
    const hits=all.filter(el=>norm(el.textContent).includes(wanted));
    if(!hits.length) return false;
    hits.sort((a,b)=>(a.textContent||'').length-(b.textContent||'').length);
    const leaf=hits[0];
    let target=leaf;
    for(let i=0;i<8 && target.parentElement;i++){
      const role=target.getAttribute?.('role');
      if(target.tagName==='BUTTON'||target.tagName==='A'||role==='button'||role==='link'||target.hasAttribute?.('tabindex')) break;
      target=target.parentElement;
    }
    try{ target.scrollIntoView({block:'center',inline:'center'}); }catch{}
    try{ target.click(); }catch{}
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
      try{ target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window})); }catch{}
    }
    return true;
  },text).catch(()=>false);
  if(domClicked && await waitForDetailGrid(frame,15000)) return true;

  // Siste fallback: ekte museklikk på tekstens koordinat.
  try{
    const textLoc=frame.getByText(text,{exact:false}).first();
    const box=await textLoc.boundingBox();
    if(box){
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
      if(await waitForDetailGrid(frame,15000)) return true;
    }
  }catch{}
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

async function resetGridToTop(grid){
  await grid.evaluate(el=>{
    const nodes=[el,...el.querySelectorAll('*')];
    let p=el.parentElement;
    for(let i=0;i<6&&p;i++,p=p.parentElement) nodes.push(p);
    for(const x of nodes){ if(x.scrollHeight>x.clientHeight+25) x.scrollTop=0; }
  }).catch(()=>{});
  await sleep(500);
}

async function scrollGrid(grid){
  return await grid.evaluate(el=>{
    const nodes=[el,...el.querySelectorAll('*')];
    let p=el.parentElement;
    for(let i=0;i<6&&p;i++,p=p.parentElement) nodes.push(p);
    const candidates=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25 && x.clientHeight>40);
    candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
    const s=candidates[0];
    if(!s) return {moved:false,bottom:true};
    const before=s.scrollTop;
    const max=s.scrollHeight-s.clientHeight;
    s.scrollTop=Math.min(max,before+Math.max(160,s.clientHeight*.72));
    s.dispatchEvent(new Event('scroll',{bubbles:true}));
    return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3,before,after:s.scrollTop,max};
  }).catch(()=>({moved:false,bottom:false}));
}

async function collectAllRows(grid){
  await resetGridToTop(grid);
  const unique=new Map();
  let stale=0;
  let bottomSeen=0;
  try{ await grid.click({position:{x:20,y:40},force:true,timeout:3000}); }catch{}
  for(let step=0;step<260;step++){
    const rows=await visibleRows(grid);
    const before=unique.size;
    for(const r of rows) unique.set(keyRow(r),r);
    stale=unique.size===before?stale+1:0;

    const scroll=await scrollGrid(grid);
    if(scroll.bottom) bottomSeen++;
    else bottomSeen=0;
    if(!scroll.moved){
      try{ await grid.press('PageDown'); }catch{}
    }
    await sleep(220);
    if(bottomSeen>=3 && stale>=3) break;
    if(stale>=14) break;
  }
  return [...unique.values()];
}

function parseGrid(rows,status){
  const header=rows.find(r=>r.some(x=>x.includes('Prisområde')) && r.some(x=>x.includes('(MW)')));
  if(!header) return [];
  const idx=(needle)=>header.findIndex(h=>h.toLowerCase().includes(needle.toLowerCase()));
  const iCase=idx('Statnett saksnr');
  const iTilko=idx('Tilko saksnr');
  const iStation=idx('Stasjon for tilknytning');
  const iPlan=idx('Områdeplan');
  const iArea=idx('Prisområde');
  const iCustomer=idx('Statnetts kunde');
  const iEnd=idx('Sluttkunde');
  const iIndustry=idx('Næringstype');
  const iMw=header.findIndex(h=>h.includes('(MW)'));
  const iDate=header.findIndex(h=>h.toLowerCase().includes('dato'));
  if([iArea,iEnd,iIndustry,iMw].some(i=>i<0)) return [];

  return rows.filter(r=>r!==header && r[iArea] && /^NO\d$/i.test(r[iArea])).map(r=>({
    id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),
    statnett_case:iCase>=0?r[iCase]||null:null,
    tilko_case:iTilko>=0?r[iTilko]||null:null,
    station:iStation>=0?r[iStation]||null:null,
    area_plan:iPlan>=0?r[iPlan]||null:null,
    area:r[iArea].toUpperCase(),
    grid_customer:iCustomer>=0?r[iCustomer]||null:null,
    end_customer:r[iEnd]||null,
    industry:r[iIndustry]||null,
    mw:n(r[iMw]),
    date:iDate>=0?r[iDate]||null:null,
    status,
    source:'Statnett'
  })).filter(r=>r.mw!=null && r.mw>=0);
}

async function extractOnce({heading,listText,status,key}){
  const frame=await findReportFrame(heading,listText);
  if(!frame) throw new Error(`Fant ikke ${heading}-frame`);
  if(!await clickList(frame,listText)) throw new Error(`Klarte ikke åpne ${heading}-listen`);

  // Power BI kan regenerere visualene etter klikk. Vent litt og bruk samme frame
  // bare dersom den fremdeles er gyldig.
  await sleep(2500);
  const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
  const gc=await grids.count();
  if(gc===0) throw new Error(`${heading}: ingen tabeller funnet etter klikk`);

  const parsed=[];
  const diagnostics=[];
  for(let i=0;i<gc;i++){
    const rows=await collectAllRows(grids.nth(i));
    const p=parseGrid(rows,status);
    const productionCount=p.filter(x=>productionTypes.has(x.industry)).length;
    const nonProduction=p.length-productionCount;
    diagnostics.push({grid:i,unique_rows:rows.length,parsed_count:p.length,production_count:productionCount,non_production_count:nonProduction,sample:rows.slice(0,5)});
    parsed.push({rows:p,productionCount,nonProduction});
  }

  // Velg eksplisitt tabellen som ser mest ut som forbrukstabellen.
  parsed.sort((a,b)=>b.nonProduction-a.nonProduction);
  const consumption=(parsed[0]?.rows||[]).filter(x=>!productionTypes.has(x.industry));
  const scoped=consumption.filter(x=>x.area==='NO1'||x.area==='NO5');

  await fs.writeFile(path.join(RAW,`${key}-${day}-diagnostic.json`),JSON.stringify({
    fetched_at:now,heading,grid_count:gc,diagnostics,selected_count:scoped.length,
    selected_mw:scoped.reduce((a,x)=>a+(x.mw||0),0)
  },null,2));

  if(scoped.length===0) throw new Error(`${heading}: fant 0 NO1/NO5-forbrukssaker`);
  return scoped;
}

async function extractWithRetry(config){
  let lastError=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      console.log(`${config.heading}: forsøk ${attempt}/3`);
      if(attempt>1){
        await loadSource();
      }
      const rows=await extractOnce(config);
      console.log(`${config.heading}: ${rows.length} NO1/NO5-saker`);
      return rows;
    }catch(err){
      lastError=err;
      console.error(`${config.heading}: forsøk ${attempt} feilet: ${err.message}`);
      await page.screenshot({path:path.join(RAW,`${config.key}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});
      if(attempt<3) await sleep(2500*attempt);
    }
  }
  throw lastError;
}

async function readPrevious(){
  try{return JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf-8'));}catch{return null;}
}

function validateDataset(current,previous){
  const errors=[];
  const all=[...current.queue,...current.reservations];
  if(!current.queue.length) errors.push('Kapasitetskø er tom');
  if(!current.reservations.length) errors.push('Reservasjoner er tom');
  if(all.some(x=>!['NO1','NO5'].includes(x.area))) errors.push('Uventet prisområde i output');
  if(all.some(x=>x.mw==null||!Number.isFinite(x.mw))) errors.push('Ugyldig MW-verdi');

  // Hvis vi har et tidligere godt datasett, beskytt dashboardet mot plutselig
  // massiv datanedgang som typisk skyldes virtualisering/Power BI-feil.
  if(previous?.totals){
    for(const kind of ['queue','reservations']){
      for(const area of ['NO1','NO5']){
        const oldMw=previous.totals?.[kind]?.[area]?.mw||0;
        const newMw=current.totals?.[kind]?.[area]?.mw||0;
        if(oldMw>100 && newMw<oldMw*0.45){
          errors.push(`${kind} ${area}: ny MW (${newMw}) er under 45% av forrige (${oldMw})`);
        }
      }
    }
  }
  return errors;
}

await loadSource();
const previous=await readPrevious();

console.log('Henter kapasitetskø...');
const queue=await extractWithRetry({heading:'Kapasitetskø',listText:'Se liste over saker i kapasitetskø',status:'Kapasitetskø',key:'queue'});
console.log('Henter reservasjoner...');
const reservations=await extractWithRetry({heading:'Reservasjoner',listText:'Se liste over reservasjoner',status:'Reservert',key:'reservations'});

const current={
  updated_at:now,
  source:'Statnett – offentlige Power BI-lister',
  source_url:SOURCE,
  scope:'Forbruk, NO1 og NO5',
  queue,
  reservations,
  totals:{
    queue:{NO1:total(queue,'NO1'),NO5:total(queue,'NO5')},
    reservations:{NO1:total(reservations,'NO1'),NO5:total(reservations,'NO5')}
  }
};

const validationErrors=validateDataset(current,previous);
await fs.writeFile(path.join(RAW,`validation-${day}.json`),JSON.stringify({updated_at:now,ok:validationErrors.length===0,errors:validationErrors,totals:current.totals},null,2));
if(validationErrors.length){
  throw new Error(`Datasett avvist av kvalitetskontroll: ${validationErrors.join('; ')}`);
}

// Publiser først etter at HELE datasettet har bestått kvalitetskontrollen.
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2));

let history=[];
try{ history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf-8')); }catch{}
const point={
  date:day,updated_at:now,
  queue_NO1:current.totals.queue.NO1.mw,
  queue_NO5:current.totals.queue.NO5.mw,
  reserved_NO1:current.totals.reservations.NO1.mw,
  reserved_NO5:current.totals.reservations.NO5.mw
};
history=history.filter(x=>x.date!==day);
history.push(point);
history.sort((a,b)=>a.date.localeCompare(b.date));
await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));

console.log('Kvalitetskontroll: OK');
console.log('Ferdig:',JSON.stringify(current.totals));
await browser.close();
