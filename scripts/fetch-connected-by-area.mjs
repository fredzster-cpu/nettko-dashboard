import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#tilknyttet-kapasitet';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

const browser=await chromium.launch({headless:true});

async function openReport(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
  let frame=null;
  for(let i=0;i<35&&!frame;i++){
    for(const f of page.frames().filter(x=>x.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(t.includes('Tilknyttet kapasitet')){frame=f;break;}
    }
    if(!frame) await page.waitForTimeout(800);
  }
  if(!frame) throw new Error('Power BI-frame ikke funnet');
  return {context,page,frame};
}

async function chooseArea(frame,page,area){
  // Try to find the Prisområde slicer and open its current selection (usually “Alle”).
  const labels=frame.getByText('Prisområde',{exact:true});
  const n=await labels.count().catch(()=>0);
  for(let i=0;i<n;i++){
    const label=labels.nth(i);
    const containers=[label.locator('xpath=..'),label.locator('xpath=../..'),label.locator('xpath=../../..')];
    for(const c of containers){
      try{
        const text=(await c.innerText({timeout:1500})).replace(/\s+/g,' ');
        if(!text.includes('Prisområde')) continue;
        const all=c.getByText('Alle',{exact:true});
        if(await all.count()){
          await all.first().click({force:true}); await page.waitForTimeout(900);
          const option=frame.getByText(area,{exact:true});
          if(await option.count()){await option.last().click({force:true});await page.waitForTimeout(2500);return true;}
        }
      }catch{}
    }
  }
  // Fallback: click an “Alle” whose nearby text contains Prisområde.
  const alls=frame.getByText('Alle',{exact:true});
  const ac=await alls.count().catch(()=>0);
  for(let i=0;i<ac;i++){
    const a=alls.nth(i);
    try{
      let p=a; let hit=false;
      for(let up=0;up<5;up++){p=p.locator('xpath=..');const t=(await p.innerText({timeout:900})).replace(/\s+/g,' ');if(t.includes('Prisområde')){hit=true;break;}}
      if(!hit) continue;
      await a.click({force:true}); await page.waitForTimeout(900);
      const option=frame.getByText(area,{exact:true});
      if(await option.count()){await option.last().click({force:true});await page.waitForTimeout(2500);return true;}
    }catch{}
  }
  return false;
}

async function openDetails(frame,page){
  for(const loc of [frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false}),frame.getByRole('button',{name:/tilknyttet kapasitet/i}),frame.getByRole('link',{name:/tilknyttet kapasitet/i})]){
    try{if(await loc.count()){await loc.first().click({force:true});await page.waitForTimeout(3000);break;}}catch{}
  }
  for(let r=0;r<35;r++){
    const grids=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await grids.count();i++){
      const t=await grids.nth(i).innerText({timeout:1500}).catch(()=>'');
      if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')) return grids.nth(i);
    }
    await page.waitForTimeout(700);
  }
  throw new Error('detaljtabell ikke funnet');
}

async function visibleRows(grid){
  const rows=grid.locator('[role="row"]'),out=[];
  for(let i=0;i<await rows.count();i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const c=cells.map(x=>x.replace(/\s+/g,' ').trim()); if(c.some(Boolean)) out.push(c);
  }
  return out;
}
async function scroll(grid,reset=false){return grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=c[0];if(!s)return {moved:false,bottom:true};if(reset){s.scrollTop=0;return {moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.7));s.dispatchEvent(new Event('scroll',{bubbles:true}));return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}))}
async function collect(grid,page){await scroll(grid,true);await page.waitForTimeout(500);const u=new Map();let stale=0,bottom=0;for(let step=0;step<500;step++){for(const r of await visibleRows(grid))u.set(r.join('|'),r);const before=u.size;const s=await scroll(grid,false);await page.waitForTimeout(200);stale=u.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break;}return [...u.values()]}

function parse(rows,area){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt'))); if(!h)return[];
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato'));
  const iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  return rows.filter(r=>r!==h).map(r=>({
    id:(r[iCase]||r[iTilko]||`Tilknyttet-${area}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),
    statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,
    area,grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry:iIndustry>=0?r[iIndustry]||null:null,mw:iMw>=0?num(r[iMw]):null,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_filter'
  })).filter(r=>r.mw!=null&&!productionTypes.has(r.industry));
}

async function extractArea(area){
  let lastErr;
  for(let attempt=1;attempt<=3;attempt++){
    const {context,page,frame}=await openReport();
    try{
      console.log(`Tilknyttet ${area}: forsøk ${attempt}/3`);
      if(!await chooseArea(frame,page,area)) throw new Error(`klarte ikke sette Prisområde=${area}`);
      const grid=await openDetails(frame,page); const rows=await collect(grid,page); const data=parse(rows,area);
      const t=total(data);
      await fs.writeFile(path.join(RAW,`connected-${area}-${day}-explicit-filter.json`),JSON.stringify({updated_at:now,area,cases:t.cases,mw:t.mw,rows:data},null,2));
      if(!data.length||t.mw<=0) throw new Error(`tomt uttrekk for ${area}`);
      await context.close(); return data;
    }catch(e){lastErr=e;await page.screenshot({path:path.join(RAW,`connected-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<3)await sleep(2500*attempt);}
  }
  throw lastErr;
}

const no1=await extractArea('NO1');
const no5=await extractArea('NO5');
const t1=total(no1),t5=total(no5);
if(day==='2026-08-19'&&Math.abs(t1.mw-296)>0.01) throw new Error(`NO1 kontrollsum avviker: ${t1.mw} MW mot Statnett 296 MW`);
const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
current.connected=[...no1,...no5]; current.status_meta ||= {}; current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_filter:current.connected.length}}; current.totals ||= {}; current.totals.connected={NO1:t1,NO5:t5}; current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
console.log('TILKNYTTET EKSPLOSITT PRISOMRÅDE-FILTER VALIDERT');console.log(JSON.stringify({NO1:t1,NO5:t5}));
await browser.close();
