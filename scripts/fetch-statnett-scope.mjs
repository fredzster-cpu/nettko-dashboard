import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const [,,key,area]=process.argv;
const AREAS=['NO1','NO2','NO3','NO4','NO5'];
if(!AREAS.includes(area)) throw new Error(`Ugyldig prisområde: ${area}`);

const configs={
  queue:{status:'Kapasitetskø',heading:'Kapasitetskø',list:'Se liste over saker i kapasitetskø',url:'https://app.powerbi.com/view?pageName=e919fd623fe16c1f1b5b&r=eyJrIjoiYTM4N2MzZGMtMGMwYi00MjMwLThjNWYtYTBhMmNkYTVkNmFmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',tolerance:1},
  reservations:{status:'Reservert',heading:'Reservasjoner',list:'Se liste over reservasjoner',url:'https://app.powerbi.com/view?pageName=ccba661604c0f2acf1b4&r=eyJrIjoiZTVkMmNiNDQtM2VhZi00OGQ0LWE0YTAtMjMyOGMxMzhlYmZmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',tolerance:1},
  connected:{status:'Tilknyttet',heading:'Tilknyttet kapasitet',list:'Se liste over saker med tilknyttet kapasitet',url:'https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',tolerance:0.01},
  withdrawn:{status:'Tilbaketrukket',heading:'Tilbaketrukket kapasitet',list:'Se liste over saker med tilbaketrukket kapasitet',url:'https://app.powerbi.com/view?r=eyJrIjoiZjhkMjM1OWQtMDBlYS00NDUzLWE4YTMtNjA4YmYzMWQ2MDFlIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',tolerance:0.01}
};
const cfg=configs[key]; if(!cfg) throw new Error(`Ugyldig statusnøkkel: ${key}`);

const ROOT=process.cwd(),DATA=path.join(ROOT,'data'),RAW=path.join(DATA,'raw'),STAGE=path.join(DATA,'staging');
await fs.mkdir(RAW,{recursive:true});await fs.mkdir(STAGE,{recursive:true});
const now=new Date().toISOString(),day=now.slice(0,10);
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s??'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

async function open(browser){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}}),page=await context.newPage();page.setDefaultTimeout(20000);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(9000);
  let frame=null;
  for(let n=0;n<45&&!frame;n++){
    for(const f of page.frames()){
      const t=await f.locator('body').innerText({timeout:1600}).catch(()=>'');
      if(t.includes('Prisområde')&&t.includes('Forbruk (MW)')&&(t.includes(cfg.heading)||t.includes(cfg.list))){frame=f;break;}
    }
    if(!frame)await page.waitForTimeout(600);
  }
  if(!frame){await context.close();throw new Error('Power BI-frame ikke funnet')}
  return {context,page,frame};
}
async function selected(frame){const lines=(await frame.locator('body').innerText({timeout:2500}).catch(()=>'')).split(/\r?\n/).map(clean).filter(Boolean);for(let i=0;i<lines.length;i++)if(lines[i]==='Prisområde'&&lines.slice(i+1,i+6).includes(area))return true;return false}
async function setArea(frame,page){
  if(await selected(frame))return true;
  const labels=frame.getByText('Prisområde',{exact:true});
  for(let li=0;li<await labels.count().catch(()=>0);li++){
    let root=labels.nth(li);
    for(let up=0;up<8;up++){
      try{
        if(clean(await root.innerText({timeout:700})).includes('Prisområde')){
          for(const curName of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=root.getByText(curName,{exact:true});if(!(await cur.count()))continue;
            await cur.first().click({force:true});await page.waitForTimeout(650);
            const opts=frame.getByText(area,{exact:true});if(await opts.count()){await opts.last().click({force:true});await page.waitForTimeout(2400);if(await selected(frame))return true}
          }
        }
      }catch{}
      root=root.locator('xpath=..');
    }
  }
  return false;
}
function readKpi(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean),h=lines.findIndex(x=>x.toLowerCase().includes(cfg.heading.toLowerCase())),start=Math.max(0,h);
  for(let i=start;i<Math.min(lines.length,start+180);i++)if(lines[i]==='Forbruk (MW)')for(let j=i+1;j<Math.min(lines.length,i+12);j++){
    if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j]))break;const v=num(lines[j]);if(v!=null&&v>=0)return v;
  }
  throw new Error('Forbruk-KPI ikke funnet');
}
async function openDetails(frame,page){
  const link=frame.getByText(cfg.list,{exact:false});if(!(await link.count().catch(()=>0)))throw new Error(`Detaljlenke ikke funnet: ${cfg.list}`);
  await link.first().click({force:true});await page.waitForTimeout(3200);
}
async function findGrid(frame,page){for(let r=0;r<45;r++){const gs=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');for(let i=0;i<await gs.count();i++){const t=await gs.nth(i).innerText({timeout:1100}).catch(()=>'');if(t.includes('Næringstype')&&t.includes('(MW)'))return gs.nth(i)}await page.waitForTimeout(500)}throw new Error('Detaljtabell ikke funnet')}
async function visibleRows(grid){const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]),r=cells.map(clean);if(r.some(Boolean))out.push(r)}return out}
async function scrollGrid(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return{moved:false,bottom:true};if(reset){s.scrollTop=0;return{moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(150,s.clientHeight*.7));s.dispatchEvent(new Event('scroll',{bubbles:true}));return{moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}
async function collect(grid,page){await scrollGrid(grid,true);await page.waitForTimeout(450);const u=new Map();let stale=0,bottom=0;for(let i=0;i<650;i++){const before=u.size;for(const r of await visibleRows(grid))u.set(r.join('|'),r);const s=await scrollGrid(grid);await page.waitForTimeout(180);stale=u.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=28)break}return [...u.values()]}
function parse(raw){
  const h=raw.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.includes('(MW)')));if(!h)throw new Error('Kolonneheader ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  let iMw=-1;
  if(key==='connected')iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  if(iMw<0)iMw=h.findIndex(x=>x.includes('(MW)'));
  if(iIndustry<0||iMw<0)throw new Error('Obligatoriske kolonner mangler');
  const out=[];
  for(const r of raw){if(r===h)continue;const ind=iIndustry>=0?r[iIndustry]||null:null,mw=iMw>=0?num(r[iMw]):null,sc=iCase>=0?r[iCase]||null:null,gc=iCustomer>=0?r[iCustomer]||null:null,ec=iEnd>=0?r[iEnd]||null:null;if(clean(sc).toLowerCase()==='totalt'||(!sc&&!gc&&!ec)||mw==null||mw<=0||productionTypes.has(ind))continue;const shownArea=iArea>=0?clean(r[iArea]).toUpperCase():area;if(shownArea&&AREAS.includes(shownArea)&&shownArea!==area)continue;out.push({id:(sc||(iTilko>=0?r[iTilko]:null)||`${cfg.status}-${area}-${ec||gc}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:sc,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area,grid_customer:gc,end_customer:ec,industry:ind,mw,date:iDate>=0?r[iDate]||null:null,status:cfg.status,source:'Statnett',area_method:'powerbi_filter_validated'});}
  return out;
}

const browser=await chromium.launch({headless:true});let last;
try{
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await open(browser);
    try{
      console.log(`${key} ${area}: forsøk ${attempt}/4`);
      if(!await setArea(frame,page))throw new Error(`oversikt: klarte ikke sette Prisområde=${area}`);
      const overview=await frame.locator('body').innerText(),kpi=readKpi(overview);
      await openDetails(frame,page);
      if(!await setArea(frame,page))throw new Error(`detalj: klarte ikke sette Prisområde=${area}`);
      if(!await selected(frame))throw new Error(`detalj: Prisområde=${area} kunne ikke verifiseres`);
      await page.waitForTimeout(1800);
      const grid=await findGrid(frame,page),raw=await collect(grid,page),rows=parse(raw),t=total(rows);
      const keys=rows.map(r=>`${r.statnett_case||''}|${r.tilko_case||''}|${r.station||''}|${r.end_customer||''}|${r.mw}|${r.date||''}`),dups=[...new Set(keys.filter((x,i)=>keys.indexOf(x)!==i))];
      if(dups.length)throw new Error(`${dups.length} duplikatrader`);
      const delta=Math.abs(Math.round(t.mw)-Math.round(kpi));
      if(delta>cfg.tolerance)throw new Error(`radtotal ${t.mw} MW matcher ikke KPI ${kpi} MW (delta ${delta})`);
      const result={ok:true,updated_at:now,key,status:cfg.status,area,kpi_mw:kpi,row_mw:t.mw,cases:t.cases,delta_mw:delta,rows};
      await fs.writeFile(path.join(STAGE,`${key}-${area}.json`),JSON.stringify(result,null,2)+'\n');
      await fs.writeFile(path.join(RAW,`scope-${key}-${area}-${day}.json`),JSON.stringify(result,null,2)+'\n');
      console.log(`VALIDERT ${key} ${area}: ${t.cases} saker / ${t.mw} MW mot KPI ${kpi}`);await context.close();process.exit(0);
    }catch(e){last=e;console.error(`${key} ${area}: ${e.message}`);await page.screenshot({path:path.join(RAW,`scope-${key}-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(1500*attempt)}
  }
} finally {await browser.close()}
await fs.writeFile(path.join(STAGE,`${key}-${area}.error.json`),JSON.stringify({ok:false,updated_at:now,key,area,error:String(last?.message||last)},null,2)+'\n');
throw last;
