import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9';
const now=new Date().toISOString(), day=now.slice(0,10);
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const browser=await chromium.launch({headless:true});

async function open(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(9000);
  let frame=null;
  for(let n=0;n<40&&!frame;n++){
    for(const f of page.frames()){
      const t=await f.locator('body').innerText({timeout:1800}).catch(()=>'');
      if(t.includes('Tilknyttet kapasitet')&&t.includes('Prisområde')&&t.includes('Forbruk (MW)')){frame=f;break;}
    }
    if(!frame) await page.waitForTimeout(600);
  }
  if(!frame){await context.close();throw new Error('Power BI-frame ikke funnet');}
  return {context,page,frame};
}

async function selected(frame,area){
  const lines=(await frame.locator('body').innerText({timeout:2000}).catch(()=>'' )).split(/\r?\n/).map(clean).filter(Boolean);
  for(let i=0;i<lines.length;i++) if(lines[i]==='Prisområde'&&lines.slice(i+1,i+5).includes(area)) return true;
  return false;
}

async function setArea(frame,page,area){
  if(await selected(frame,area)) return true;
  const labels=frame.getByText('Prisområde',{exact:true});
  for(let li=0;li<await labels.count().catch(()=>0);li++){
    let root=labels.nth(li);
    for(let up=0;up<7;up++){
      try{
        if(clean(await root.innerText({timeout:700})).includes('Prisområde')){
          for(const curName of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=root.getByText(curName,{exact:true});
            if(!(await cur.count())) continue;
            await cur.first().click({force:true}); await page.waitForTimeout(650);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){
              await opts.last().click({force:true}); await page.waitForTimeout(2500);
              if(await selected(frame,area)) return true;
            }
          }
        }
      }catch{}
      root=root.locator('xpath=..');
    }
  }
  return false;
}

function readOverviewKpi(body){
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

async function gotoDetails(frame,page){
  const link=frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false});
  if(!(await link.count().catch(()=>0))) throw new Error('Detaljlenke ikke funnet');
  await link.first().click({force:true}); await page.waitForTimeout(3200);
  const body=await frame.locator('body').innerText({timeout:4000}).catch(()=>'' );
  if(!body.includes('Liste over saker med tilknyttet kapasitet - Forbruk')) throw new Error('Detaljvisning ikke åpnet');
}

async function findGrid(frame,page){
  for(let r=0;r<45;r++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await grids.count();i++){
      const t=await grids.nth(i).innerText({timeout:1100}).catch(()=>'');
      if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')) return grids.nth(i);
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Detaljtabell ikke funnet');
}

async function visibleRows(grid){
  const rs=grid.locator('[role="row"]'),out=[];
  for(let i=0;i<await rs.count();i++){
    const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const row=cells.map(clean); if(row.some(Boolean)) out.push(row);
  }
  return out;
}
async function scrollGrid(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return{moved:false,bottom:true};if(reset){s.scrollTop=0;return{moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.7));s.dispatchEvent(new Event('scroll',{bubbles:true}));return{moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}
async function collect(grid,page){await scrollGrid(grid,true);await page.waitForTimeout(450);const u=new Map();let stale=0,bottom=0;for(let step=0;step<500;step++){const before=u.size;for(const r of await visibleRows(grid))u.set(r.join('|'),r);const s=await scrollGrid(grid,false);await page.waitForTimeout(180);stale=u.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break;}return [...u.values()]}

function parseRows(raw,area){
  const h=raw.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));
  if(!h) throw new Error('Kolonneheader ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const out=[];
  for(const r of raw){
    if(r===h)continue;
    const sc=iCase>=0?r[iCase]||null:null,gc=iCustomer>=0?r[iCustomer]||null:null,ec=iEnd>=0?r[iEnd]||null:null,ind=iIndustry>=0?r[iIndustry]||null:null,mw=iMw>=0?num(r[iMw]):null;
    if(clean(sc).toLowerCase()==='totalt'||(!sc&&!gc&&!ec)||mw==null||mw<=0||productionTypes.has(ind))continue;
    out.push({id:(sc||(iTilko>=0?r[iTilko]:null)||`Tilknyttet-${area}-${ec||gc}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:sc,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area,grid_customer:gc,end_customer:ec,industry:ind,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_detail_filter'});
  }
  return out;
}

async function extract(area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await open();
    try{
      console.log(`Tilknyttet v4 ${area}: forsøk ${attempt}/4`);
      if(!await setArea(frame,page,area)) throw new Error(`oversikt: klarte ikke sette Prisområde=${area}`);
      const overview=await frame.locator('body').innerText();
      const kpi=readOverviewKpi(overview);
      console.log(`Tilknyttet Statnett KPI ${area}: ${kpi} MW`);
      await gotoDetails(frame,page);
      // Statnett nullstiller sliceren til "Alle" når detaljsiden åpnes. Sett prisområdet på nytt der.
      const detailBefore=await frame.locator('body').innerText();
      await fs.writeFile(path.join(RAW,`connected-v4-${area}-${day}-detail-before.txt`),detailBefore);
      if(!await setArea(frame,page,area)) throw new Error(`detalj: klarte ikke sette Prisområde=${area}`);
      if(!await selected(frame,area)) throw new Error(`detalj: Prisområde=${area} kunne ikke verifiseres`);
      await page.waitForTimeout(2200);
      const detailAfter=await frame.locator('body').innerText();
      await fs.writeFile(path.join(RAW,`connected-v4-${area}-${day}-detail-after.txt`),detailAfter);
      const grid=await findGrid(frame,page), raw=await collect(grid,page), rows=parseRows(raw,area), t=total(rows);
      const keys=rows.map(r=>`${r.statnett_case||''}|${r.tilko_case||''}|${r.station||''}|${r.end_customer||''}|${r.mw}`),dups=[...new Set(keys.filter((x,i)=>keys.indexOf(x)!==i))];
      await fs.writeFile(path.join(RAW,`connected-v4-${area}-${day}.json`),JSON.stringify({updated_at:now,area,kpi,cases:t.cases,mw:t.mw,duplicates:dups,rows},null,2));
      if(!rows.length) throw new Error(`${area}: ingen detaljrader`);
      if(dups.length) throw new Error(`${area}: ${dups.length} duplikatrader`);
      if(Math.abs(t.mw-kpi)>0.01) throw new Error(`${area}: filtrert detaljradtotal ${t.mw} MW matcher ikke Statnett KPI ${kpi} MW`);
      await context.close(); return {rows,kpi};
    }catch(e){lastErr=e;await fs.writeFile(path.join(RAW,`connected-v4-${area}-${day}-attempt-${attempt}.txt`),String(e?.stack||e)).catch(()=>{});await page.screenshot({path:path.join(RAW,`connected-v4-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(1800*attempt);}
  }
  throw lastErr;
}

try{
  const x1=await extract('NO1'),x5=await extract('NO5');
  const t1=total(x1.rows),t5=total(x5.rows);
  const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
  current.connected=[...x1.rows,...x5.rows];
  current.status_meta ||= {}; current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_detail_filter:current.connected.length},validated_against_statnett_kpi:true};
  current.totals ||= {}; current.totals.connected={NO1:t1,NO5:t5};
  current.statnett_display_totals ||= {}; current.statnett_display_totals.connected={NO1:x1.kpi,NO5:x5.kpi};
  current.updated_at=now;
  await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
  let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{}
  let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
  console.log('TILKNYTTET V4 VALIDERT',JSON.stringify({NO1:t1,NO5:t5,kpi:{NO1:x1.kpi,NO5:x5.kpi}}));
} finally { await browser.close(); }
