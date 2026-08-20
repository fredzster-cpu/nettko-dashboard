import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s??'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

function parseForbruk(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  const h=lines.findIndex(x=>x==='Tilknyttet kapasitet');
  for(let i=Math.max(0,h);i<Math.min(lines.length,Math.max(0,h)+80);i++){
    if(lines[i]==='Forbruk (MW)'){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
        const v=num(lines[j]); if(v!=null&&v>0) return v;
      }
    }
  }
  throw new Error('Forbruk-KPI ikke funnet');
}

async function areaSelected(frame,area){
  const body=await frame.locator('body').innerText({timeout:2500}).catch(()=>'');
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(lines[i]!=='Prisområde') continue;
    const nearby=lines.slice(i+1,i+6);
    if(nearby.includes(area)) return true;
  }
  return false;
}

async function chooseArea(frame,page,area){
  if(await areaSelected(frame,area)) return true;
  const labels=frame.getByText('Prisområde',{exact:true});
  for(let i=0;i<await labels.count().catch(()=>0);i++){
    let p=labels.nth(i);
    for(let up=0;up<7;up++){
      try{
        const txt=clean(await p.innerText({timeout:900}));
        if(txt.includes('Prisområde')){
          for(const curLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=p.getByText(curLabel,{exact:true});
            if(!(await cur.count())) continue;
            await cur.first().click({force:true}); await page.waitForTimeout(800);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){
              await opts.last().click({force:true}); await page.waitForTimeout(3200);
              const body=await frame.locator('body').innerText();
              await fs.writeFile(path.join(RAW,`connected-filter-${area}-${day}-overview.txt`),body);
              if(await areaSelected(frame,area)) return true;
            }
          }
        }
      }catch{}
      p=p.locator('xpath=..');
    }
  }
  // Global fallback, but only accept after explicit verification that the slicer displays the requested area.
  for(const curLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
    const vals=frame.getByText(curLabel,{exact:true});
    for(let i=0;i<await vals.count().catch(()=>0);i++){
      const node=vals.nth(i);
      try{
        let p=node,hit=false;
        for(let up=0;up<7;up++){
          p=p.locator('xpath=..');
          const txt=clean(await p.innerText({timeout:700}));
          if(txt.includes('Prisområde')){hit=true;break}
        }
        if(!hit) continue;
        await node.click({force:true}); await page.waitForTimeout(800);
        const opt=frame.getByText(area,{exact:true});
        if(await opt.count()){
          await opt.last().click({force:true}); await page.waitForTimeout(3200);
          if(await areaSelected(frame,area)) return true;
        }
      }catch{}
    }
  }
  return false;
}

async function collectGrid(grid,page){
  const visible=async()=>{const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);const c=cells.map(clean);if(c.some(Boolean))out.push(c)}return out};
  const scroll=async(reset=false)=>grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return {moved:false,bottom:true};if(reset){s.scrollTop=0;return {moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65));s.dispatchEvent(new Event('scroll',{bubbles:true}));return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}));
  await scroll(true); await page.waitForTimeout(500); const uniq=new Map();let stale=0,bottom=0;
  for(let step=0;step<500;step++){const before=uniq.size;for(const r of await visible())uniq.set(r.join('|'),r);const s=await scroll(false);await page.waitForTimeout(220);stale=uniq.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break}
  return [...uniq.values()];
}

function parseRows(rows,area){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));if(!h)return[];
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const out=[];
  for(const r of rows.filter(x=>x!==h)){
    const mw=num(r[iMw]),industry=r[iIndustry]||null;
    if(mw==null||productionTypes.has(industry)) continue;
    const statnettCase=iCase>=0?r[iCase]||null:null;
    if(!statnettCase && !r[iEnd] && !r[iCustomer]) continue;
    out.push({id:(statnettCase||r[iTilko]||`Tilknyttet-${area}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:statnettCase,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area,grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_overview_filter'});
  }
  return out;
}

const browser=await chromium.launch({headless:true});
async function extractArea(area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});const page=await context.newPage();page.setDefaultTimeout(20000);
    try{
      console.log(`Tilknyttet filtrert ${area}: forsøk ${attempt}/4`);
      await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(9000);
      let frame=null;for(let r=0;r<35&&!frame;r++){for(const f of page.frames()){const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');if(t.includes('Tilknyttet kapasitet')&&t.includes('Prisområde')){frame=f;break}}if(!frame)await page.waitForTimeout(700)}
      if(!frame)throw new Error('rapport-frame ikke funnet');
      if(!await chooseArea(frame,page,area))throw new Error(`klarte ikke velge og verifisere Prisområde=${area}`);
      const overview=await frame.locator('body').innerText();const kpi=parseForbruk(overview);
      await fs.writeFile(path.join(RAW,`connected-filter-${area}-${day}-overview.txt`),overview);
      const link=frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false});if(!(await link.count()))throw new Error('detaljlenke ikke funnet');
      await link.first().click({force:true});await page.waitForTimeout(3500);
      // Verify that the selected price area survived navigation to the detail view.
      if(!await areaSelected(frame,area)) throw new Error(`${area} filter forsvant ved åpning av detaljtabellen`);
      let grid=null;for(let r=0;r<35&&!grid;r++){const gs=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');for(let i=0;i<await gs.count();i++){const t=await gs.nth(i).innerText({timeout:1500}).catch(()=>'');if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')){grid=gs.nth(i);break}}if(!grid)await page.waitForTimeout(700)}
      if(!grid)throw new Error('detaljtabell ikke funnet');
      const raw=await collectGrid(grid,page);const rows=parseRows(raw,area);const t=total(rows);
      await fs.writeFile(path.join(RAW,`connected-filter-${area}-${day}-diagnostic.json`),JSON.stringify({updated_at:now,area,kpi,filter_verified:true,rows_total:t,rows},null,2));
      if(!rows.length)throw new Error('ingen forbruksrader');
      if(Math.round(t.mw)!==Math.round(kpi))throw new Error(`${area} filtrerte detaljrader matcher ikke Statnett-KPI: rader ${t.mw} MW vs KPI ${kpi} MW`);
      await context.close();return {rows,kpi};
    }catch(e){lastErr=e;console.error(e.message);await page.screenshot({path:path.join(RAW,`connected-filter-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(1800*attempt)}
  }
  throw lastErr;
}

const a1=await extractArea('NO1');const a5=await extractArea('NO5');await browser.close();
const rows=[...a1.rows,...a5.rows];
const ids=new Set();for(const r of rows){const k=`${r.area}|${r.id}`;if(ids.has(k))throw new Error(`duplikat ${k}`);ids.add(k)}
let current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
current.connected=rows;current.status_meta ||= {};current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_overview_filter:rows.length}};current.totals ||= {};current.totals.connected={NO1:total(a1.rows),NO5:total(a5.rows)};current.statnett_display_totals ||= {};current.statnett_display_totals.connected={NO1:a1.kpi,NO5:a5.kpi};current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
console.log('TILKNYTTET FILTRERT PER PRISOMRÅDE VALIDERT',JSON.stringify(current.totals.connected));
