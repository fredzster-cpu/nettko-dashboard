import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#tilknyttet-kapasitet';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

const browser=await chromium.launch({headless:true});

function parseForbruk(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  const h=lines.findIndex(x=>x==='Tilknyttet kapasitet');
  for(let i=Math.max(0,h);i<Math.min(lines.length,Math.max(0,h)+100);i++){
    if(lines[i]==='Forbruk (MW)'){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
        const v=num(lines[j]); if(v!=null&&v>=0) return v;
      }
    }
  }
  throw new Error('Forbruk-KPI ikke funnet etter prisområdefilter');
}

async function openReport(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
  let frame=null;
  for(let i=0;i<35&&!frame;i++){
    for(const f of page.frames().filter(x=>x.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(t.includes('Tilknyttet kapasitet')&&t.includes('Prisområde')){frame=f;break;}
    }
    if(!frame) await page.waitForTimeout(800);
  }
  if(!frame) throw new Error('Power BI-frame ikke funnet');
  return {context,page,frame};
}

async function areaSelected(frame,area){
  const lines=(await frame.locator('body').innerText({timeout:2500}).catch(()=>''))
    .split(/\r?\n/).map(clean).filter(Boolean);
  for(let i=0;i<lines.length;i++) if(lines[i]==='Prisområde'&&lines.slice(i+1,i+6).includes(area)) return true;
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
            const cur=p.getByText(curLabel,{exact:true}); if(!(await cur.count())) continue;
            await cur.first().click({force:true}); await page.waitForTimeout(700);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){
              await opts.last().click({force:true}); await page.waitForTimeout(2600);
              if(await areaSelected(frame,area)) return true;
            }
          }
        }
      }catch{}
      p=p.locator('xpath=..');
    }
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
    const c=cells.map(clean); if(c.some(Boolean)) out.push(c);
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
  return rows.filter(r=>r!==h).map(r=>{
    const statnettCase=iCase>=0?r[iCase]||null:null;
    const gridCustomer=iCustomer>=0?r[iCustomer]||null:null;
    const endCustomer=iEnd>=0?r[iEnd]||null:null;
    const industry=iIndustry>=0?r[iIndustry]||null:null;
    const mw=iMw>=0?num(r[iMw]):null;
    if(clean(statnettCase).toLowerCase()==='totalt') return null;
    if(!statnettCase&&!gridCustomer&&!endCustomer) return null;
    if(mw==null||mw<=0||productionTypes.has(industry)) return null;
    return {
      id:(statnettCase||(iTilko>=0?r[iTilko]:null)||`Tilknyttet-${area}-${endCustomer||gridCustomer}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),
      statnett_case:statnettCase,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,
      area,grid_customer:gridCustomer,end_customer:endCustomer,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_filter'
    };
  }).filter(Boolean);
}

async function extractArea(area){
  let lastErr;
  for(let attempt=1;attempt<=3;attempt++){
    const {context,page,frame}=await openReport();
    try{
      console.log(`Tilknyttet ${area}: forsøk ${attempt}/3`);
      if(!await chooseArea(frame,page,area)) throw new Error(`klarte ikke sette Prisområde=${area}`);
      const filteredBody=await frame.locator('body').innerText();
      const kpi=parseForbruk(filteredBody);
      console.log(`Tilknyttet Statnett KPI ${area}: ${kpi} MW`);
      const grid=await openDetails(frame,page); const rows=await collect(grid,page); const data=parse(rows,area);
      const t=total(data);
      const keys=data.map(r=>`${r.statnett_case||''}|${r.tilko_case||''}|${r.station||''}|${r.end_customer||''}|${r.mw}`);
      const duplicates=keys.filter((x,i)=>keys.indexOf(x)!==i);
      await fs.writeFile(path.join(RAW,`connected-${area}-${day}-explicit-filter.json`),JSON.stringify({updated_at:now,area,kpi,cases:t.cases,mw:t.mw,duplicates:[...new Set(duplicates)],rows:data},null,2));
      if(!data.length||t.mw<=0) throw new Error(`tomt uttrekk for ${area}`);
      if(duplicates.length) throw new Error(`${area} har ${duplicates.length} duplikatrader`);
      if(Math.round(t.mw)!==Math.round(kpi)) throw new Error(`${area} detaljradtotal ${t.mw} MW matcher ikke filtrert Statnett-KPI ${kpi} MW`);
      await context.close(); return {rows:data,kpi};
    }catch(e){lastErr=e;await page.screenshot({path:path.join(RAW,`connected-${area}-${day}-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<3)await sleep(2500*attempt);}
  }
  throw lastErr;
}

const x1=await extractArea('NO1');
const x5=await extractArea('NO5');
const no1=x1.rows,no5=x5.rows,t1=total(no1),t5=total(no5);
const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
current.connected=[...no1,...no5];
current.status_meta ||= {};
current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_filter:current.connected.length},validated_against_statnett_kpi:true};
current.totals ||= {};
current.totals.connected={NO1:t1,NO5:t5};
current.statnett_display_totals ||= {};
current.statnett_display_totals.connected={NO1:x1.kpi,NO5:x5.kpi};
current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
console.log('TILKNYTTET EKSPLISITT PRISOMRÅDE-FILTER VALIDERT');console.log(JSON.stringify({NO1:t1,NO5:t5,kpi:{NO1:x1.kpi,NO5:x5.kpi}}));
await browser.close();
