import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const selections=['Alle','NO1','NO2','NO3','NO4','NO5'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

function parseForbruk(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  const h=lines.findIndex(x=>x==='Tilknyttet kapasitet');
  if(h<0) throw new Error('Tilknyttet kapasitet ikke funnet');
  for(let i=h;i<Math.min(lines.length,h+120);i++){
    if(lines[i]==='Forbruk (MW)'){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
        const v=num(lines[j]); if(v!=null&&v>=0) return v;
      }
    }
  }
  throw new Error('Forbruk-KPI ikke funnet');
}

async function openReport(browser){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(9000);
  for(let n=0;n<40;n++){
    for(const frame of page.frames()){
      const body=await frame.locator('body').innerText({timeout:1500}).catch(()=>'');
      if(body.includes('Tilknyttet kapasitet')&&body.includes('Prisområde')) return {context,page,frame};
    }
    await page.waitForTimeout(600);
  }
  await context.close();
  throw new Error('Power BI rapport-frame ikke funnet');
}

async function slicerContainer(frame){
  const labels=frame.getByText('Prisområde',{exact:true});
  let best=null,bestLen=Infinity;
  for(let i=0;i<await labels.count().catch(()=>0);i++){
    let p=labels.nth(i);
    for(let up=0;up<9;up++){
      try{
        const txt=clean(await p.innerText({timeout:700}));
        if(txt.includes('Prisområde')&&txt.length<bestLen&&txt.length<220){best=p;bestLen=txt.length;}
      }catch{}
      p=p.locator('xpath=..');
    }
  }
  return best;
}

async function selectedArea(frame){
  const c=await slicerContainer(frame); if(!c) return null;
  const raw=await c.innerText({timeout:1500}).catch(()=>'');
  const lines=raw.split(/\r?\n/).map(clean).filter(Boolean);
  const idx=lines.indexOf('Prisområde');
  const after=idx>=0?lines.slice(idx+1):lines;
  for(const x of after) if(selections.includes(x)) return x;
  return null;
}

async function clickVisibleExact(frame,text){
  const loc=frame.getByText(text,{exact:true});
  for(let i=0;i<await loc.count().catch(()=>0);i++){
    const x=loc.nth(i);
    if(await x.isVisible().catch(()=>false)){
      try{await x.click({force:true,timeout:2500});return true;}catch{}
    }
  }
  const opts=frame.locator('[role="option"],[role="menuitem"],[role="listbox"] *');
  for(let i=0;i<await opts.count().catch(()=>0);i++){
    const x=opts.nth(i);
    if(clean(await x.innerText({timeout:300}).catch(()=>''))===text&&await x.isVisible().catch(()=>false)){
      try{await x.click({force:true,timeout:2500});return true;}catch{}
    }
  }
  return false;
}

async function chooseArea(frame,page,area){
  for(let round=0;round<5;round++){
    const before=await selectedArea(frame);
    if(before===area) return true;
    const c=await slicerContainer(frame);
    if(!c){await page.waitForTimeout(800);continue;}

    let opened=false;
    for(const selector of ['[role="combobox"]','[aria-haspopup="listbox"]','button']){
      const xs=c.locator(selector);
      for(let i=0;i<await xs.count().catch(()=>0);i++){
        const x=xs.nth(i);
        if(await x.isVisible().catch(()=>false)){
          try{await x.click({force:true,timeout:2000});opened=true;break;}catch{}
        }
      }
      if(opened) break;
    }
    if(!opened&&before){opened=await clickVisibleExact(c,before);}
    if(!opened){try{await c.click({force:true,timeout:2000});opened=true;}catch{}}
    await page.waitForTimeout(700);

    const clicked=await clickVisibleExact(frame,area);
    if(!clicked){await page.keyboard.press('Escape').catch(()=>{});await page.waitForTimeout(600);continue;}
    await page.waitForTimeout(2600);
    if(await selectedArea(frame)===area) return true;
  }
  return false;
}

async function openDetails(frame,page){
  const link=frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false});
  if(!(await link.count().catch(()=>0))) throw new Error('Detaljlenke for tilknyttet kapasitet ikke funnet');
  await link.first().click({force:true});
  await page.waitForTimeout(3200);
  for(let r=0;r<40;r++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await grids.count();i++){
      const t=await grids.nth(i).innerText({timeout:1200}).catch(()=>'');
      if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')) return grids.nth(i);
    }
    await page.waitForTimeout(600);
  }
  throw new Error('Detaljtabell ikke funnet');
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]'),out=[];
  for(let i=0;i<await rows.count();i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const c=cells.map(clean); if(c.some(Boolean)) out.push(c);
  }
  return out;
}

async function scrollGrid(grid,reset=false){
  return grid.evaluate((el,reset)=>{
    const nodes=[el,...el.querySelectorAll('*')]; let p=el.parentElement;
    for(let i=0;i<8&&p;i++,p=p.parentElement) nodes.push(p);
    const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40)
      .sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
    const s=cs[0]; if(!s) return {moved:false,bottom:true};
    if(reset){s.scrollTop=0;return {moved:true,bottom:false};}
    const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;
    s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.7));
    s.dispatchEvent(new Event('scroll',{bubbles:true}));
    return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3};
  },reset).catch(()=>({moved:false,bottom:false}));
}

async function collect(grid,page){
  await scrollGrid(grid,true); await page.waitForTimeout(500);
  const uniq=new Map(); let stale=0,bottom=0;
  for(let step=0;step<500;step++){
    const before=uniq.size;
    for(const r of await visibleRows(grid)) uniq.set(r.join('|'),r);
    const s=await scrollGrid(grid,false); await page.waitForTimeout(200);
    stale=uniq.size===before?stale+1:0; bottom=s.bottom?bottom+1:0;
    if(bottom>=3&&stale>=3) break; if(stale>=25) break;
  }
  return [...uniq.values()];
}

function parseRows(rows,area){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));
  if(!h) throw new Error('Kolonneheader i detaljtabell ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  const iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const out=[];
  for(const r of rows){
    if(r===h) continue;
    const statnettCase=iCase>=0?r[iCase]||null:null, gridCustomer=iCustomer>=0?r[iCustomer]||null:null, endCustomer=iEnd>=0?r[iEnd]||null:null;
    const industry=iIndustry>=0?r[iIndustry]||null:null, mw=iMw>=0?num(r[iMw]):null;
    if(clean(statnettCase).toLowerCase()==='totalt') continue;
    if(!statnettCase&&!gridCustomer&&!endCustomer) continue;
    if(mw==null||mw<=0||productionTypes.has(industry)) continue;
    out.push({
      id:(statnettCase||(iTilko>=0?r[iTilko]:null)||`Tilknyttet-${area}-${endCustomer||gridCustomer}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),
      statnett_case:statnettCase,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,
      area,grid_customer:gridCustomer,end_customer:endCustomer,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_filter'
    });
  }
  return out;
}

async function extractArea(browser,area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await openReport(browser);
    try{
      console.log(`Tilknyttet ${area}: forsøk ${attempt}/4`);
      if(!await chooseArea(frame,page,area)) throw new Error(`klarte ikke sette Prisområde=${area}`);
      const selected=await selectedArea(frame);
      if(selected!==area) throw new Error(`Prisområde-verifikasjon feilet: ønsket ${area}, fant ${selected}`);
      const filteredBody=await frame.locator('body').innerText();
      const kpi=parseForbruk(filteredBody);
      console.log(`Tilknyttet Statnett KPI ${area}: ${kpi} MW`);
      const grid=await openDetails(frame,page);
      const raw=await collect(grid,page), rows=parseRows(raw,area), t=total(rows);
      const keys=rows.map(r=>`${r.statnett_case||''}|${r.tilko_case||''}|${r.station||''}|${r.end_customer||''}|${r.mw}`);
      const duplicates=[...new Set(keys.filter((x,i)=>keys.indexOf(x)!==i))];
      await fs.writeFile(path.join(RAW,`connected-v2-${area}-${day}.json`),JSON.stringify({updated_at:now,selected,kpi,cases:t.cases,mw:t.mw,duplicates,rows},null,2));
      if(!rows.length) throw new Error(`${area}: ingen detaljrader`);
      if(duplicates.length) throw new Error(`${area}: duplikatrader ${duplicates.length}`);
      if(Math.abs(t.mw-kpi)>0.01) throw new Error(`${area}: detaljradtotal ${t.mw} MW matcher ikke Statnett KPI ${kpi} MW`);
      await context.close();
      return {rows,kpi};
    }catch(e){
      lastErr=e;
      await fs.writeFile(path.join(RAW,`connected-v2-${area}-${day}-attempt-${attempt}.txt`),String(e?.stack||e)).catch(()=>{});
      await page.screenshot({path:path.join(RAW,`connected-v2-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});
      await context.close().catch(()=>{});
      if(attempt<4) await sleep(1800*attempt);
    }
  }
  throw lastErr;
}

const browser=await chromium.launch({headless:true});
try{
  const x1=await extractArea(browser,'NO1');
  const x5=await extractArea(browser,'NO5');
  const t1=total(x1.rows),t5=total(x5.rows);
  const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
  current.connected=[...x1.rows,...x5.rows];
  current.status_meta ||= {};
  current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_filter:current.connected.length},validated_against_statnett_kpi:true};
  current.totals ||= {}; current.totals.connected={NO1:t1,NO5:t5};
  current.statnett_display_totals ||= {}; current.statnett_display_totals.connected={NO1:x1.kpi,NO5:x5.kpi};
  current.updated_at=now;
  await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
  let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{}
  let point=history.find(x=>x.date===day)||{date:day};
  point.updated_at=now; point.connected_NO1=t1.mw; point.connected_NO5=t5.mw;
  history=history.filter(x=>x.date!==day); history.push(point); history.sort((a,b)=>a.date.localeCompare(b.date));
  await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
  console.log('TILKNYTTET V2 VALIDERT DIREKTE MOT STATNETT',JSON.stringify({NO1:t1,NO5:t5,kpi:{NO1:x1.kpi,NO5:x5.kpi}}));
} finally {
  await browser.close();
}
