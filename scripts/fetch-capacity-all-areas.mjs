import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw'), SNAP=path.join(DATA,'snapshots');
await fs.mkdir(RAW,{recursive:true}); await fs.mkdir(SNAP,{recursive:true});
const now=new Date().toISOString(), day=now.slice(0,10), areas=['NO1','NO2','NO3','NO4','NO5'];
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const configs=[
  {key:'queue',status:'Kapasitetskø',minCases:100,minMw:5000,url:'https://app.powerbi.com/view?pageName=e919fd623fe16c1f1b5b&r=eyJrIjoiYTM4N2MzZGMtMGMwYi00MjMwLThjNWYtYTBhMmNkYTVkNmFmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'},
  {key:'reservations',status:'Reservert',minCases:30,minMw:500,url:'https://app.powerbi.com/view?pageName=ccba661604c0f2acf1b4&r=eyJrIjoiZTVkMmNiNDQtM2VhZi00OGQ0LWE0YTAtMjMyOGMxMzhlYmZmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'},
  {key:'withdrawn',status:'Tilbaketrukket',minCases:3,minMw:20,url:'https://app.powerbi.com/view?r=eyJrIjoiZjhkMjM1OWQtMDBlYS00NDUzLWE4YTMtNjA4YmYzMWQ2MDFlIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9'}
];
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s??'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=(rows,a)=>{const x=rows.filter(r=>r.area===a);return {cases:x.length,mw:x.reduce((s,r)=>s+(Number(r.mw)||0),0)}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function open(browser,cfg){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}}),page=await context.newPage();page.setDefaultTimeout(18000);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(9000);
  let frame=null;
  for(let n=0;n<45&&!frame;n++){
    for(const f of page.frames()){
      const t=await f.locator('body').innerText({timeout:1800}).catch(()=>'');
      if(t.includes('Prisområde')&&t.includes('Næringstype')&&(t.includes('Statnett saksnr')||t.includes('Se liste over'))){frame=f;break;}
    }
    if(!frame)await page.waitForTimeout(600);
  }
  if(!frame){await context.close();throw new Error('Power BI-frame ikke funnet')}
  return {context,page,frame};
}
async function openDetail(frame,page){
  for(let r=0;r<5;r++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await grids.count();i++){const t=await grids.nth(i).innerText({timeout:1000}).catch(()=>'');if(t.includes('Prisområde')&&t.includes('Næringstype')&&t.includes('(MW)'))return grids.nth(i)}
    const links=frame.getByText(/Se liste over/i);if(await links.count().catch(()=>0)){await links.first().click({force:true}).catch(()=>{});await page.waitForTimeout(3000)}
  }
  for(let r=0;r<35;r++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await grids.count();i++){const t=await grids.nth(i).innerText({timeout:1000}).catch(()=>'');if(t.includes('Prisområde')&&t.includes('Næringstype')&&t.includes('(MW)'))return grids.nth(i)}
    await page.waitForTimeout(500);
  }
  throw new Error('Detaljtabell ikke funnet');
}
async function visibleRows(grid){const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const c=(await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[])).map(clean);if(c.some(Boolean))out.push(c)}return out}
async function scrollGrid(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return{moved:false,bottom:true};if(reset){s.scrollTop=0;return{moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(150,s.clientHeight*.7));s.dispatchEvent(new Event('scroll',{bubbles:true}));return{moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}
async function collect(grid,page){await scrollGrid(grid,true);await page.waitForTimeout(400);const u=new Map();let stale=0,bottom=0;for(let i=0;i<700;i++){const before=u.size;for(const r of await visibleRows(grid))u.set(r.join('|'),r);const s=await scrollGrid(grid);await page.waitForTimeout(170);stale=u.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=30)break}return [...u.values()]}
function parse(raw,status){
  const h=raw.find(r=>r.some(x=>x.includes('Prisområde'))&&r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.includes('(MW)')));if(!h)throw new Error('Kolonneheader ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iMw=h.findIndex(x=>x.includes('(MW)')),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  if(iArea<0||iIndustry<0||iMw<0)throw new Error('Obligatoriske kolonner mangler');
  return raw.filter(r=>r!==h&&areas.includes(clean(r[iArea]).toUpperCase())).map(r=>({id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area:clean(r[iArea]).toUpperCase(),grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry:r[iIndustry]||null,mw:num(r[iMw]),date:iDate>=0?r[iDate]||null:null,status,source:'Statnett'})).filter(r=>r.mw!=null&&r.mw>0&&!productionTypes.has(r.industry));
}
async function extract(browser,cfg){let err;for(let attempt=1;attempt<=4;attempt++){const {context,page,frame}=await open(browser,cfg);try{console.log(`${cfg.status}: forsøk ${attempt}`);const grid=await openDetail(frame,page),raw=await collect(grid,page),rows=parse(raw,cfg.status),mw=rows.reduce((s,r)=>s+r.mw,0);await fs.writeFile(path.join(RAW,`${cfg.key}-all-${day}.json`),JSON.stringify({updated_at:now,cases:rows.length,mw,by_area:Object.fromEntries(areas.map(a=>[a,total(rows,a)])),rows},null,2));if(rows.length<cfg.minCases||mw<cfg.minMw)throw new Error(`ufullstendig: ${rows.length} saker / ${mw} MW`);await context.close();return rows}catch(e){err=e;await page.screenshot({path:path.join(RAW,`${cfg.key}-all-${day}-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(1600*attempt)}}throw err}

const browser=await chromium.launch({headless:true});
try{
  let previous={};try{previous=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'))}catch{}
  const datasets={},status_meta={};
  for(const cfg of configs){try{datasets[cfg.key]=await extract(browser,cfg);status_meta[cfg.key]={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false}}catch(e){throw new Error(`${cfg.status} feilet: ${e.message}`)}}
  datasets.connected=previous.connected||[];status_meta.connected=previous.status_meta?.connected||{ok:false,fresh:false,error:'venter på tilknyttet-henter'};
  const totals={};for(const k of ['queue','reservations','withdrawn','connected'])totals[k]=Object.fromEntries(areas.map(a=>[a,total(datasets[k]||[],a)]));
  const current={updated_at:now,source:'Statnett – offentlig Power BI',source_url:'https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/',scope:'Forbruk, NO1–NO5',...datasets,status_meta,totals,statnett_display_totals:previous.statnett_display_totals||{}};
  await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
  let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;for(const k of ['queue','reservations','withdrawn'])for(const a of areas)point[`${k}_${a}`]=totals[k][a].mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
  await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2)+'\n');console.log('ALLE PRISOMRÅDER HENTET',JSON.stringify(totals));
} finally {await browser.close()}
