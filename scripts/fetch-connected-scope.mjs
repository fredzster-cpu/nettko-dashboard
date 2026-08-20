import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#tilknyttet-kapasitet';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s??'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

let current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
const browser=await chromium.launch({headless:true});

async function findFrame(page){
  for(let r=0;r<40;r++){
    for(const f of page.frames().filter(x=>x.url().includes('app.powerbi.com'))){
      const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(t.includes('Tilknyttet kapasitet')&&t.includes('Prisområde')) return f;
    }
    await page.waitForTimeout(700);
  }
  return null;
}

async function chooseArea(frame,page,area){
  const labels=frame.getByText('Prisområde',{exact:true});
  for(let i=0;i<await labels.count().catch(()=>0);i++){
    let node=labels.nth(i);
    for(let up=0;up<7;up++){
      try{
        const txt=clean(await node.innerText({timeout:900}));
        if(txt.includes('Prisområde')){
          for(const curLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=node.getByText(curLabel,{exact:true});
            if(!(await cur.count())) continue;
            if(curLabel===area) return true;
            await cur.first().click({force:true}); await page.waitForTimeout(600);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){await opts.last().click({force:true});await page.waitForTimeout(2200);return true;}
          }
        }
      }catch{}
      node=node.locator('xpath=..');
    }
  }
  return false;
}

function readDisplayedForbruk(body){
  const lines=String(body||'').split(/\r?\n/).map(clean).filter(Boolean);
  const start=Math.max(0,lines.findIndex(x=>x.includes('Tilknyttet kapasitet')));
  for(let i=start;i<Math.min(lines.length,start+180);i++){
    if(lines[i]==='Forbruk (MW)'){
      for(let j=i+1;j<Math.min(lines.length,i+12);j++){
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
        const v=num(lines[j]); if(v!=null&&v>0) return v;
      }
    }
  }
  throw new Error('Kunne ikke lese Statnett Forbruk (MW)');
}

async function clickDetails(frame,page){
  const candidates=[frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false}),frame.getByRole('button',{name:/liste over saker med tilknyttet kapasitet/i}),frame.getByRole('link',{name:/liste over saker med tilknyttet kapasitet/i})];
  for(const loc of candidates){
    try{if(await loc.count()){await loc.first().click({force:true});await page.waitForTimeout(2800);return;}}catch{}
  }
  throw new Error('Kunne ikke åpne detaljlisten');
}

async function findGrid(frame,page){
  for(let r=0;r<40;r++){
    const gs=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');
    for(let i=0;i<await gs.count();i++){
      const t=await gs.nth(i).innerText({timeout:1500}).catch(()=>'');
      if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')) return gs.nth(i);
    }
    await page.waitForTimeout(650);
  }
  throw new Error('Detaljtabell ikke funnet');
}

async function collect(grid,page){
  const scroll=async(reset=false)=>grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=c[0];if(!s)return{moved:false,bottom:true};if(reset){s.scrollTop=0;return{moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(120,s.clientHeight*.55));s.dispatchEvent(new Event('scroll',{bubbles:true}));return{moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}));
  const visible=async()=>{const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]),c=cells.map(clean);if(c.some(Boolean))out.push(c)}return out};
  await scroll(true);await page.waitForTimeout(500);const uniq=new Map();let stale=0,bottom=0;
  for(let step=0;step<650;step++){
    const before=uniq.size;for(const r of await visible())uniq.set(r.join('|'),r);
    const s=await scroll(false);await page.waitForTimeout(190);stale=uniq.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;
    if(bottom>=4&&stale>=4)break;if(stale>=35)break;
  }
  return [...uniq.values()];
}

function parse(rows,area){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')));if(!h)throw new Error('Header ikke funnet');
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const out=[];
  for(const r of rows.filter(x=>x!==h)){
    const caseNo=r[iCase]||r[iTilko]||'';if(/^totalt$/i.test(clean(caseNo)))continue;
    const mw=num(r[iMw]),industry=r[iIndustry]||null;if(mw==null||productionTypes.has(industry))continue;
    out.push({id:(caseNo||`Tilknyttet-${area}-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:r[iCase]||null,tilko_case:r[iTilko]||null,station:r[iStation]||null,area_plan:r[iPlan]||null,area,grid_customer:r[iCustomer]||null,end_customer:r[iEnd]||null,industry,mw,date:r[iDate]||null,status:'Tilknyttet',source:'Statnett',area_method:'powerbi_price_area_filter'});
  }
  const seen=new Set();return out.filter(r=>{const k=[r.statnett_case,r.tilko_case,r.station,r.end_customer,r.mw,r.date].join('|');if(seen.has(k))return false;seen.add(k);return true;});
}

async function extractArea(area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}}),page=await context.newPage();page.setDefaultTimeout(20000);
    try{
      console.log(`Tilknyttet ${area}: forsøk ${attempt}/4`);
      await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForTimeout(9000);
      const frame=await findFrame(page);if(!frame)throw new Error('Power BI-frame ikke funnet');
      if(!await chooseArea(frame,page,area))throw new Error(`Kunne ikke sette Prisområde=${area}`);
      const overview=await frame.locator('body').innerText();const displayed=readDisplayedForbruk(overview);
      await clickDetails(frame,page);const grid=await findGrid(frame,page);const rawRows=await collect(grid,page);const rows=parse(rawRows,area);const t=total(rows);
      await fs.writeFile(path.join(RAW,`connected-${area}-${day}-direct.json`),JSON.stringify({updated_at:now,area,displayed_mw:displayed,row_cases:t.cases,row_mw:t.mw,rows},null,2));
      if(!rows.length)throw new Error('Ingen rader lest');
      if(Math.round(t.mw)!==Math.round(displayed))throw new Error(`${area}: detaljrader ${t.mw} MW vs Statnett ${displayed} MW`);
      await context.close();console.log(`${area} OK: ${t.cases} saker / ${t.mw} MW, Statnett ${displayed} MW`);return {rows,displayed};
    }catch(e){lastErr=e;console.error(e.message);await page.screenshot({path:path.join(RAW,`connected-${area}-${day}-direct-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(2200*attempt);}
  }
  throw lastErr;
}

try{
  const no1=await extractArea('NO1');
  const no5=await extractArea('NO5');
  const rows=[...no1.rows,...no5.rows],t1=total(no1.rows),t5=total(no5.rows);
  current.connected=rows;current.status_meta||={};current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{powerbi_price_area_filter:rows.length}};current.totals||={};current.totals.connected={NO1:t1,NO5:t5};current.statnett_display_totals||={};current.statnett_display_totals.connected={NO1:no1.displayed,NO5:no5.displayed};current.updated_at=now;
  await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
  let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
  console.log('TILKNYTTET DIREKTE PRISOMRÅDE-UTTREKK VALIDERT');
} finally {await browser.close();}
