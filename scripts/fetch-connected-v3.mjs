import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9';
const now=new Date().toISOString(), day=now.slice(0,10);
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s||'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const browser=await chromium.launch({headless:true});

async function openReport(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(9000);
  let frame=null,best=null;
  for(let i=0;i<40&&!frame;i++){
    for(const f of page.frames()){
      const txt=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(!txt) continue;
      if(txt.includes('Tilknyttet kapasitet')&&txt.includes('Prisområde')&&txt.includes('Forbruk (MW)')){frame=f;break;}
      if(txt.includes('Prisområde')&&txt.includes('Forbruk (MW)')&&(!best||txt.length>best.txt.length)) best={f,txt};
    }
    if(!frame) await page.waitForTimeout(700);
  }
  if(!frame&&best) frame=best.f;
  if(!frame){await context.close();throw new Error('Power BI-frame ikke funnet');}
  return {context,page,frame};
}

async function selectedArea(frame,area){
  const lines=(await frame.locator('body').innerText({timeout:2500}).catch(()=>''))
    .split(/\r?\n/).map(clean).filter(Boolean);
  for(let i=0;i<lines.length;i++) if(lines[i]==='Prisområde'&&lines.slice(i+1,i+5).includes(area)) return true;
  return false;
}

async function chooseArea(frame,page,area){
  if(await selectedArea(frame,area)) return true;
  const labels=frame.getByText('Prisområde',{exact:true});
  for(let i=0;i<await labels.count().catch(()=>0);i++){
    let node=labels.nth(i);
    for(let up=0;up<7;up++){
      try{
        const txt=clean(await node.innerText({timeout:1000}));
        if(txt.includes('Prisområde')){
          for(const currentLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=node.getByText(currentLabel,{exact:true}); if(!(await cur.count())) continue;
            await cur.first().click({force:true}); await page.waitForTimeout(700);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){
              await opts.last().click({force:true}); await page.waitForTimeout(2500);
              if(await selectedArea(frame,area)) return true;
            }
          }
        }
      }catch{}
      node=node.locator('xpath=..');
    }
  }
  for(const currentLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
    const vals=frame.getByText(currentLabel,{exact:true});
    for(let i=0;i<await vals.count().catch(()=>0);i++){
      const node=vals.nth(i);
      try{
        let p=node,hit=false;
        for(let up=0;up<7;up++){p=p.locator('xpath=..');const txt=clean(await p.innerText({timeout:700}));if(txt.includes('Prisområde')){hit=true;break;}}
        if(!hit) continue;
        if(currentLabel===area&&await selectedArea(frame,area)) return true;
        await node.click({force:true}); await page.waitForTimeout(700);
        const opt=frame.getByText(area,{exact:true});
        if(await opt.count()){
          await opt.last().click({force:true}); await page.waitForTimeout(2500);
          if(await selectedArea(frame,area)) return true;
        }
      }catch{}
    }
  }
  return false;
}

function readKpi(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  const h=lines.findIndex(x=>x==='Tilknyttet kapasitet');
  for(let i=Math.max(0,h);i<Math.min(lines.length,Math.max(0,h)+120);i++){
    if(lines[i]==='Forbruk (MW)') for(let j=i+1;j<Math.min(lines.length,i+12);j++){
      if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
      const v=num(lines[j]); if(v!=null&&v>=0) return v;
    }
  }
  throw new Error('Forbruk-KPI ikke funnet');
}

async function openDetails(frame,page){
  const link=frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false});
  if(!(await link.count().catch(()=>0))) throw new Error('Detaljlenke ikke funnet');
  await link.first().click({force:true}); await page.waitForTimeout(3200);
  for(let r=0;r<45;r++){
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

async function scrollGrid(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return{moved:false,bottom:true};if(reset){s.scrollTop=0;return{moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.7));s.dispatchEvent(new Event('scroll',{bubbles:true}));return{moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}

async function collect(grid,page){await scrollGrid(grid,true);await page.waitForTimeout(500);const u=new Map();let stale=0,bottom=0;for(let step=0;step<500;step++){const before=u.size;for(const r of await visibleRows(grid))u.set(r.join('|'),r);const s=await scrollGrid(grid,false);await page.waitForTimeout(200);stale=u.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break;}return[...u.values()]}

function parseRows(rows,area){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));
  if(!h) throw new Error('Kolonneheader ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const out=[];
  for(const r of rows){
    if(r===h) continue;
    const statnettCase=iCase>=0?r[iCase]||null:null,gridCustomer=iCustomer>=0?r[iCustomer]||null:null,endCustomer=iEnd>=0?r[iEnd]||null:null,industry=iIndustry>=0?r[iIndustry]||null:null,mw=iMw>=0?num(r[iMw]):null;
    if(clean(statnettCase).toLowerCase()==='totalt'||(!statnettCase&&!gridCustomer&&!endCustomer)||mw==null||mw<=0||productionTypes.has(industry)) continue;
    out.push({id:(statnettCase||(iTilko>=0?r[iTilko]:null)||`Tilknyttet-${area}-${endCustomer||gridCustomer}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:statnettCase,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area,grid_customer:gridCustomer,end_customer:endCustomer,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_filter'});
  }
  return out;
}

async function extract(area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await openReport();
    try{
      console.log(`Tilknyttet ${area}: forsøk ${attempt}/4`);
      if(!await chooseArea(frame,page,area)) throw new Error(`klarte ikke sette Prisområde=${area}`);
      const body=await frame.locator('body').innerText();
      await fs.writeFile(path.join(RAW,`connected-v3-${area}-${day}-filtered.txt`),body);
      const kpi=readKpi(body);
      console.log(`Tilknyttet Statnett KPI ${area}: ${kpi} MW`);
      const grid=await openDetails(frame,page), raw=await collect(grid,page), rows=parseRows(raw,area), t=total(rows);
      const keys=rows.map(r=>`${r.statnett_case||''}|${r.tilko_case||''}|${r.station||''}|${r.end_customer||''}|${r.mw}`),dups=[...new Set(keys.filter((x,i)=>keys.indexOf(x)!==i))];
      await fs.writeFile(path.join(RAW,`connected-v3-${area}-${day}.json`),JSON.stringify({updated_at:now,area,kpi,cases:t.cases,mw:t.mw,duplicates:dups,rows},null,2));
      if(!rows.length) throw new Error(`${area}: ingen detaljrader`);
      if(dups.length) throw new Error(`${area}: ${dups.length} duplikatrader`);
      if(Math.abs(t.mw-kpi)>0.01) throw new Error(`${area}: detaljradtotal ${t.mw} MW matcher ikke Statnett KPI ${kpi} MW`);
      await context.close(); return {rows,kpi};
    }catch(e){lastErr=e;await fs.writeFile(path.join(RAW,`connected-v3-${area}-${day}-attempt-${attempt}.txt`),String(e?.stack||e)).catch(()=>{});await page.screenshot({path:path.join(RAW,`connected-v3-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await new Promise(r=>setTimeout(r,1800*attempt));}
  }
  throw lastErr;
}

try{
  const x1=await extract('NO1'),x5=await extract('NO5');
  const t1=total(x1.rows),t5=total(x5.rows);
  const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
  current.connected=[...x1.rows,...x5.rows];
  current.status_meta ||= {}; current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_filter:current.connected.length},validated_against_statnett_kpi:true};
  current.totals ||= {}; current.totals.connected={NO1:t1,NO5:t5};
  current.statnett_display_totals ||= {}; current.statnett_display_totals.connected={NO1:x1.kpi,NO5:x5.kpi};
  current.updated_at=now;
  await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
  let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{}
  let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
  console.log('TILKNYTTET V3 VALIDERT',JSON.stringify({NO1:t1,NO5:t5,kpi:{NO1:x1.kpi,NO5:x5.kpi}}));
} finally { await browser.close(); }
