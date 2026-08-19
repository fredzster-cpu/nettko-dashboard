import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const DATA = path.join(ROOT,'data');
const RAW = path.join(DATA,'raw');
const SNAP = path.join(DATA,'snapshots');
await fs.mkdir(RAW,{recursive:true});
await fs.mkdir(SNAP,{recursive:true});

const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8';
const now=new Date().toISOString();
const day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const browser=await chromium.launch({headless:true});

function num(s){if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null;}
function total(rows,area){const a=rows.filter(r=>r.area===area);return {cases:a.length,mw:a.reduce((s,r)=>s+(r.mw||0),0)};}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function openFresh(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(10000);
  return {context,page};
}

async function findOverview(page,heading,listText){
  for(let round=0;round<30;round++){
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:4000}).catch(()=> '');
      if(t.includes(heading)&&t.includes(listText)) return f;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function tryKnownWorkingClick(page,frame,text){
  const candidates=[
    frame.getByText(text,{exact:false}),
    frame.getByRole('button',{name:new RegExp(text,'i')}),
    frame.getByRole('link',{name:new RegExp(text,'i')})
  ];
  for(const locator of candidates){
    try{
      const count=await locator.count();
      if(count>0){
        const target=locator.first();
        await target.scrollIntoViewIfNeeded().catch(()=>{});
        await target.click({timeout:15000,force:true});
        await page.waitForTimeout(2500);
        return true;
      }
    }catch{}
  }

  const dom=await frame.evaluate(targetText=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim();
    const els=[...document.querySelectorAll('*')];
    const target=els.find(el=>norm(el.textContent)===targetText)||els.find(el=>norm(el.textContent).includes(targetText));
    if(!target)return false;
    const clickable=target.closest('button,a,[role="button"],[role="link"],[tabindex]')||target.parentElement||target;
    try{clickable.scrollIntoView({block:'center'});}catch{}
    try{clickable.click();}catch{}
    clickable.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
    return true;
  },text).catch(()=>false);
  if(dom){await page.waitForTimeout(3000);return true;}
  return false;
}

async function findDetail(page){
  for(let round=0;round<35;round++){
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const grids=f.locator('[role="grid"],[role="table"],[role="treegrid"]');
      const n=await grids.count().catch(()=>0);
      for(let i=0;i<n;i++){
        const t=await grids.nth(i).innerText({timeout:3000}).catch(()=> '');
        if(t.includes('Prisområde')&&(t.includes('(MW)')||t.includes('Næringstype'))) return f;
      }
      const body=await f.locator('body').innerText({timeout:3000}).catch(()=> '');
      if(body.includes('Statnett saksnr')&&body.includes('Prisområde')&&body.includes('Næringstype')) return f;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]');
  const n=await rows.count();
  const out=[];
  for(let i=0;i<n;i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const c=cells.map(x=>x.replace(/\s+/g,' ').trim());
    if(c.some(Boolean))out.push(c);
  }
  return out;
}

async function scrollState(grid,reset=false){
  return grid.evaluate((el,reset)=>{
    const nodes=[el,...el.querySelectorAll('*')];
    let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);
    const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
    const s=c[0];if(!s)return {moved:false,bottom:true};
    if(reset){s.scrollTop=0;return {moved:true,bottom:false};}
    const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;
    s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65));
    s.dispatchEvent(new Event('scroll',{bubbles:true}));
    return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3};
  },reset).catch(()=>({moved:false,bottom:false}));
}

async function collectGrid(grid,page){
  await scrollState(grid,true);await page.waitForTimeout(500);
  const unique=new Map();let stale=0,bottom=0;
  for(let step=0;step<350;step++){
    const rows=await visibleRows(grid);const before=unique.size;
    for(const r of rows)unique.set(r.join('|'),r);
    stale=unique.size===before?stale+1:0;
    const s=await scrollState(grid,false);bottom=s.bottom?bottom+1:0;
    if(!s.moved){try{await grid.press('PageDown');}catch{}}
    await page.waitForTimeout(220);
    if(bottom>=3&&stale>=3)break;if(stale>=18)break;
  }
  return [...unique.values()];
}

function parse(rows,status){
  const header=rows.find(r=>r.some(x=>x.includes('Prisområde'))&&r.some(x=>x.includes('(MW)')));
  if(!header)return [];
  const idx=n=>header.findIndex(h=>h.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iMw=header.findIndex(h=>h.includes('(MW)')),iDate=header.findIndex(h=>h.toLowerCase().includes('dato'));
  if([iArea,iEnd,iIndustry,iMw].some(i=>i<0))return [];
  return rows.filter(r=>r!==header&&r[iArea]&&/^NO\d$/i.test(r[iArea])).map(r=>({
    id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),
    statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area:r[iArea].toUpperCase(),grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:r[iEnd]||null,industry:r[iIndustry]||null,mw:num(r[iMw]),date:iDate>=0?r[iDate]||null:null,status,source:'Statnett'
  })).filter(r=>r.mw!=null&&r.mw>=0);
}

async function extract(config){
  let last;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page}=await openFresh();
    try{
      console.log(`${config.heading}: forsøk ${attempt}/4`);
      const overview=await findOverview(page,config.heading,config.listText);
      if(!overview)throw new Error('oversikts-frame ikke funnet');
      const clicked=await tryKnownWorkingClick(page,overview,config.listText);
      if(!clicked)throw new Error('klikk feilet');
      const detail=await findDetail(page);
      if(!detail)throw new Error('detalj-frame ikke funnet');
      const grids=detail.locator('[role="grid"],[role="table"],[role="treegrid"]');
      const gc=await grids.count();
      const candidates=[];const diagnostics=[];
      for(let i=0;i<gc;i++){
        const rows=await collectGrid(grids.nth(i),page);
        const parsed=parse(rows,config.status);
        const consumption=parsed.filter(x=>!productionTypes.has(x.industry));
        diagnostics.push({grid:i,unique_rows:rows.length,parsed_count:parsed.length,consumption_count:consumption.length,sample:rows.slice(0,4)});
        candidates.push(consumption);
      }
      candidates.sort((a,b)=>b.length-a.length);
      const scoped=(candidates[0]||[]).filter(x=>x.area==='NO1'||x.area==='NO5');
      const mw=scoped.reduce((s,r)=>s+(r.mw||0),0);
      await fs.writeFile(path.join(RAW,`${config.key}-${day}-diagnostic.json`),JSON.stringify({fetched_at:now,attempt,grid_count:gc,selected_count:scoped.length,selected_mw:mw,diagnostics},null,2));
      if(!scoped.length||mw<=0)throw new Error('tomt NO1/NO5-forbruksdatasett');
      console.log(`${config.heading}: ${scoped.length} saker, ${mw} MW`);
      await context.close();
      return scoped;
    }catch(e){
      last=e;console.error(`${config.heading}: forsøk ${attempt} feilet: ${e.message}`);
      await page.screenshot({path:path.join(RAW,`${config.key}-${day}-v3-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});
      await context.close().catch(()=>{});
      if(attempt<4)await sleep(2500*attempt);
    }
  }
  throw last;
}

async function previous(){try{return JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));}catch{return null;}}
function validate(cur,prev){
  const errors=[];
  for(const kind of ['queue','reservations'])for(const area of ['NO1','NO5']){
    const t=cur.totals[kind][area];if(t.cases<=0||t.mw<=0)errors.push(`${kind} ${area} mangler saker/MW`);
    const old=prev?.totals?.[kind]?.[area]?.mw||0;if(old>100&&t.mw<old*.55)errors.push(`${kind} ${area} falt under 55% av forrige`);
  }
  return errors;
}

const prev=await previous();
console.log('Henter kapasitetskø...');
const queue=await extract({heading:'Kapasitetskø',listText:'Se liste over saker i kapasitetskø',status:'Kapasitetskø',key:'queue'});
console.log('Henter reservasjoner...');
const reservations=await extract({heading:'Reservasjoner',listText:'Se liste over reservasjoner',status:'Reservert',key:'reservations'});

const current={updated_at:now,source:'Statnett – offentlige Power BI-lister',source_url:SOURCE,scope:'Forbruk, NO1 og NO5',queue,reservations,totals:{queue:{NO1:total(queue,'NO1'),NO5:total(queue,'NO5')},reservations:{NO1:total(reservations,'NO1'),NO5:total(reservations,'NO5')}}};
const errors=validate(current,prev);
await fs.writeFile(path.join(RAW,`validation-${day}.json`),JSON.stringify({updated_at:now,ok:!errors.length,errors,totals:current.totals},null,2));
if(errors.length)throw new Error(`Datasett avvist: ${errors.join('; ')}`);
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2));
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'));}catch{}
const point={date:day,updated_at:now,queue_NO1:current.totals.queue.NO1.mw,queue_NO5:current.totals.queue.NO5.mw,reserved_NO1:current.totals.reservations.NO1.mw,reserved_NO5:current.totals.reservations.NO5.mw};
history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));
await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
console.log('Kvalitetskontroll: OK');
console.log('Ferdig:',JSON.stringify(current.totals));
await browser.close();
