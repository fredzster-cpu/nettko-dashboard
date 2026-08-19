import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw'), SNAP=path.join(DATA,'snapshots');
await fs.mkdir(RAW,{recursive:true}); await fs.mkdir(SNAP,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/';
const now=new Date().toISOString(), day=now.slice(0,10);
const browser=await chromium.launch({headless:true});
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const configs=[
  {key:'queue',heading:'Kapasitetskø',list:'Se liste over saker i kapasitetskø',status:'Kapasitetskø',required:true,minCases:60,minMw:3000,url:'https://app.powerbi.com/view?pageName=e919fd623fe16c1f1b5b&r=eyJrIjoiYTM4N2MzZGMtMGMwYi00MjMwLThjNWYtYTBhMmNkYTVkNmFmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'},
  {key:'reservations',heading:'Reservasjoner',list:'Se liste over reservasjoner',status:'Reservert',required:false,minCases:1,minMw:1,url:'https://app.powerbi.com/view?pageName=ccba661604c0f2acf1b4&r=eyJrIjoiZTVkMmNiNDQtM2VhZi00OGQ0LWE0YTAtMjMyOGMxMzhlYmZmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'},
  {key:'withdrawn',heading:'Tilbaketrukket kapasitet',list:'Se liste over saker med tilbaketrukket kapasitet',status:'Tilbaketrukket',required:false,minCases:1,minMw:1,url:'https://app.powerbi.com/view?r=eyJrIjoiZjhkMjM1OWQtMDBlYS00NDUzLWE4YTMtNjA4YmYzMWQ2MDFlIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'},
  {key:'connected',heading:'Tilknyttet kapasitet',list:'Se liste over saker med tilknyttet kapasitet',status:'Tilknyttet',required:false,minCases:1,minMw:1,url:'https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'}
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=(rows,area)=>{const a=rows.filter(r=>r.area===area);return {cases:a.length,mw:a.reduce((s,r)=>s+(r.mw||0),0)}};

async function fresh(cfg){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
  return {context,page};
}

async function findOverview(page,cfg){
  for(let round=0;round<35;round++){
    for(const f of page.frames()){
      const t=await f.locator('body').innerText({timeout:4000}).catch(()=>'');
      if(t.includes(cfg.list)||(t.includes(cfg.heading)&&t.toLowerCase().includes('liste'))) return f;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function clickList(page,frame,cfg){
  const re=new RegExp(cfg.list.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  const candidates=[frame.getByText(cfg.list,{exact:false}),frame.getByRole('button',{name:re}),frame.getByRole('link',{name:re})];
  for(const loc of candidates){
    try{
      if(!(await loc.count())) continue;
      const el=loc.first(); await el.scrollIntoViewIfNeeded().catch(()=>{});
      for(const mode of ['click','enter','space']){
        try{
          if(mode==='click') await el.click({timeout:10000,force:true});
          if(mode==='enter') await el.press('Enter');
          if(mode==='space') await el.press('Space');
          await page.waitForTimeout(3000);
          return true;
        }catch{}
      }
    }catch{}
  }
  return await frame.evaluate(text=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim();
    const all=[...document.querySelectorAll('body *')];
    let el=all.find(x=>norm(x.textContent)===text)||all.find(x=>norm(x.textContent).includes(text));
    if(!el)return false;
    el=el.closest('button,a,[role="button"],[role="link"],[tabindex]')||el.parentElement||el;
    try{el.scrollIntoView({block:'center'});}catch{}
    for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){try{el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}))}catch{}}
    try{el.click()}catch{}
    return true;
  },cfg.list).catch(()=>false);
}

async function detailFrame(page){
  for(let round=0;round<40;round++){
    let fallback=null;
    for(const f of page.frames()){
      const grids=f.locator('[role="grid"],[role="table"],[role="treegrid"]');
      const n=await grids.count().catch(()=>0);
      for(let i=0;i<n;i++){
        const t=await grids.nth(i).innerText({timeout:2500}).catch(()=>'');
        if(t.includes('Prisområde')&&(t.includes('(MW)')||t.includes('Næringstype'))) return f;
      }
      const body=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(body.includes('Prisområde')&&body.includes('Næringstype')&&(body.includes('Sluttkunde')||body.includes('Statnett saksnr'))) fallback=f;
    }
    if(fallback)return fallback;
    await page.waitForTimeout(900);
  }
  return null;
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]'),n=await rows.count(),out=[];
  for(let i=0;i<n;i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const c=cells.map(x=>x.replace(/\s+/g,' ').trim()); if(c.some(Boolean))out.push(c);
  }
  return out;
}
async function scroll(grid,reset=false){
  return grid.evaluate((el,reset)=>{
    const nodes=[el,...el.querySelectorAll('*')]; let p=el.parentElement; for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);
    const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
    const s=c[0]; if(!s)return {moved:false,bottom:true}; if(reset){s.scrollTop=0;return {moved:true,bottom:false}};
    const before=s.scrollTop,max=s.scrollHeight-s.clientHeight; s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65)); s.dispatchEvent(new Event('scroll',{bubbles:true}));
    return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3};
  },reset).catch(()=>({moved:false,bottom:false}));
}
async function collect(grid,page){
  await scroll(grid,true); await page.waitForTimeout(500); const u=new Map(); let stale=0,bottom=0;
  for(let step=0;step<450;step++){
    const rs=await visibleRows(grid),before=u.size; for(const r of rs)u.set(r.join('|'),r); stale=u.size===before?stale+1:0;
    const s=await scroll(grid,false); bottom=s.bottom?bottom+1:0; if(!s.moved){try{await grid.press('PageDown')}catch{}}; await page.waitForTimeout(230);
    if(bottom>=3&&stale>=3)break; if(stale>=22)break;
  }
  return [...u.values()];
}

function parse(rows,status){
  const h=rows.find(r=>r.some(x=>x.includes('Prisområde'))&&r.some(x=>x.includes('(MW)'))); if(!h)return[];
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iMw=h.findIndex(x=>x.includes('(MW)')),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  if([iArea,iIndustry,iMw].some(i=>i<0))return[];
  return rows.filter(r=>r!==h&&/^NO\d$/i.test(r[iArea]||'')).map(r=>({
    id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area:r[iArea].toUpperCase(),grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry:r[iIndustry]||null,mw:num(r[iMw]),date:iDate>=0?r[iDate]||null:null,status,source:'Statnett'
  })).filter(r=>r.mw!=null&&!productionTypes.has(r.industry)&&(r.area==='NO1'||r.area==='NO5'));
}

async function extract(cfg){
  let lastError=null;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page}=await fresh(cfg);
    try{
      console.log(`${cfg.heading}: forsøk ${attempt}/4`);
      // Some reports can open directly in the detail page. Try that first.
      let df=await detailFrame(page);
      if(!df){
        const ov=await findOverview(page,cfg); if(!ov)throw new Error('oversikts-frame ikke funnet');
        if(!await clickList(page,ov,cfg))throw new Error('klikk feilet'); await page.waitForTimeout(3500);
        df=await detailFrame(page); if(!df)throw new Error('detalj-frame ikke funnet');
      }
      const grids=df.locator('[role="grid"],[role="table"],[role="treegrid"]'),gc=await grids.count(); if(!gc)throw new Error('ingen grid funnet i detaljvisning');
      const candidates=[],diag=[];
      for(let i=0;i<gc;i++){const rows=await collect(grids.nth(i),page);const parsed=parse(rows,cfg.status);diag.push({grid:i,rows:rows.length,parsed:parsed.length,sample:rows.slice(0,4)});candidates.push(parsed)}
      candidates.sort((a,b)=>b.length-a.length); const data=candidates[0]||[],mw=data.reduce((s,r)=>s+r.mw,0);
      await fs.writeFile(path.join(RAW,`${cfg.key}-${day}-prod-diagnostic.json`),JSON.stringify({updated_at:now,url:cfg.url,attempt,grid_count:gc,cases:data.length,mw,diag},null,2));
      if(data.length<cfg.minCases||mw<cfg.minMw)throw new Error(`ufullstendig uttrekk (${data.length} saker / ${mw} MW)`);
      console.log(`${cfg.heading}: ${data.length} saker, ${mw} MW`); await context.close(); return {ok:true,data,error:null};
    }catch(e){
      lastError=e; console.error(`${cfg.heading}: ${e.message}`); await page.screenshot({path:path.join(RAW,`${cfg.key}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{}); await context.close().catch(()=>{}); if(attempt<4)await sleep(2200*attempt);
    }
  }
  return {ok:false,data:null,error:lastError?.message||'ukjent feil'};
}

let previous=null; try{previous=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'))}catch{}
const results={};
for(const cfg of configs){results[cfg.key]=await extract(cfg); if(cfg.required&&!results[cfg.key].ok){await browser.close();throw new Error(`${cfg.heading} feilet og er obligatorisk: ${results[cfg.key].error}`)}}

const datasets={}; const status_meta={};
for(const cfg of configs){
  const r=results[cfg.key]; const prev=previous?.[cfg.key]||[];
  datasets[cfg.key]=r.ok?r.data:prev;
  status_meta[cfg.key]={ok:r.ok,fresh:r.ok,updated_at:r.ok?now:(previous?.status_meta?.[cfg.key]?.updated_at||null),error:r.error||null,preserved_previous:!r.ok&&prev.length>0};
}
const totals={}; for(const cfg of configs)totals[cfg.key]={NO1:total(datasets[cfg.key],'NO1'),NO5:total(datasets[cfg.key],'NO5')};
const current={updated_at:now,source:'Statnett – offentlig Power BI',source_url:SOURCE,scope:'Forbruk, NO1 og NO5',...datasets,status_meta,totals};
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)); await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2));
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{}
const point={date:day,updated_at:now}; for(const cfg of configs)for(const area of ['NO1','NO5'])point[`${cfg.key}_${area}`]=status_meta[cfg.key].ok?totals[cfg.key][area].mw:null;
history=history.filter(x=>x.date!==day); history.push(point); history.sort((a,b)=>a.date.localeCompare(b.date)); await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
await fs.writeFile(path.join(RAW,`capacity-prod-validation-${day}.json`),JSON.stringify({ok:true,updated_at:now,status_meta,totals},null,2));
console.log('SAMLET DATAKJØRING FERDIG'); console.log(JSON.stringify({status_meta,totals})); await browser.close();
