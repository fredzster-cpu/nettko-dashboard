import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd();
const DATA=path.join(ROOT,'data');
const RAW=path.join(DATA,'raw');
const SNAP=path.join(DATA,'snapshots');
await fs.mkdir(RAW,{recursive:true});
await fs.mkdir(SNAP,{recursive:true});

const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#kapasitetsk%C3%B8';
const now=new Date().toISOString();
const day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const browser=await chromium.launch({headless:true});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const num=s=>{if(s==null||s==='')return null;const x=Number(String(s).replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null;};
const total=(rows,area)=>{const x=rows.filter(r=>r.area===area);return {cases:x.length,mw:x.reduce((a,r)=>a+(r.mw||0),0)};};

async function openFresh(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(10000);
  return {context,page};
}

async function bodyText(frame,timeout=5000){return frame.locator('body').innerText({timeout}).catch(()=> '');}

async function findOverview(page,heading,listText){
  for(let round=0;round<40;round++){
    for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){
      const t=await bodyText(f,4000);
      if(t.includes(heading)&&t.includes(listText))return f;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function frameStats(frame){
  const t=await bodyText(frame,6000);
  const rows=await frame.locator('[role="row"]').count().catch(()=>0);
  const cells=await frame.locator('[role="gridcell"],[role="columnheader"],[role="rowheader"],[aria-rowindex][aria-colindex]').count().catch(()=>0);
  let score=0;
  if(t.includes('Statnett saksnr'))score+=2000;
  if(t.includes('Prisområde'))score+=300;
  if(t.includes('Næringstype'))score+=300;
  if(t.includes('Sluttkunde'))score+=500;
  if(t.includes('(MW)'))score+=300;
  score+=Math.min(rows,500)*5+Math.min(cells,5000);
  if(t.length>30000)score+=500;
  return {frame,text:t,rows,cells,score,url:frame.url()};
}

async function bestDetailCandidate(page){
  const stats=[];
  for(const f of page.frames().filter(f=>f.url().includes('app.powerbi.com'))){stats.push(await frameStats(f));}
  stats.sort((a,b)=>b.score-a.score);
  return {best:stats[0]||null,stats};
}

async function detailReady(page){
  const {best}=await bestDetailCandidate(page);
  return !!best && best.score>=1500 && (best.text.includes('Statnett saksnr')||best.cells>40||best.rows>10);
}

async function clickAndVerify(page,frame,text){
  const before=(await bodyText(frame)).slice(0,25000);
  const re=new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  const locators=[frame.getByText(text,{exact:false}),frame.getByRole('button',{name:re}),frame.getByRole('link',{name:re})];

  for(const loc of locators){
    try{
      if(!(await loc.count()))continue;
      const target=loc.first();
      await target.scrollIntoViewIfNeeded().catch(()=>{});
      const attempts=[
        async()=>target.click({timeout:8000,force:false}),
        async()=>target.click({timeout:8000,force:true}),
        async()=>{await target.focus();await target.press('Enter');},
        async()=>{await target.focus();await target.press('Space');}
      ];
      for(const act of attempts){
        try{await act();}catch{}
        await page.waitForTimeout(2500);
        if(await detailReady(page))return true;
        const after=(await bodyText(frame)).slice(0,25000);
        if(after!==before && (after.includes('Statnett saksnr')||after.length>before.length*1.5)){
          await page.waitForTimeout(3000);
          if(await detailReady(page))return true;
        }
      }
    }catch{}
  }

  // Coordinate click is often more reliable for Power BI text-buttons than DOM click.
  try{
    const target=frame.getByText(text,{exact:false}).first();
    const box=await target.boundingBox();
    if(box){
      for(let i=0;i<2;i++){
        await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
        await page.waitForTimeout(3500);
        if(await detailReady(page))return true;
      }
    }
  }catch{}

  // Last fallback: dispatch events on smallest matching element and ancestors.
  await frame.evaluate(targetText=>{
    const norm=s=>(s||'').replace(/\s+/g,' ').trim();
    const hits=[...document.querySelectorAll('body *')].filter(el=>norm(el.textContent).includes(targetText)).sort((a,b)=>(a.textContent||'').length-(b.textContent||'').length);
    if(!hits.length)return false;
    let el=hits[0];
    const chain=[];for(let i=0;i<8&&el;i++,el=el.parentElement)chain.push(el);
    for(const target of chain){
      try{target.scrollIntoView({block:'center'});}catch{}
      for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']){
        try{target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));}catch{}
      }
      try{target.click();}catch{}
    }
    return true;
  },text).catch(()=>false);
  await page.waitForTimeout(5000);
  return await detailReady(page);
}

async function rowsFromRole(frame){
  const out=[];
  const rows=frame.locator('[role="row"]');
  const n=await rows.count().catch(()=>0);
  for(let i=0;i<n;i++){
    const cells=await rows.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);
    const clean=cells.map(x=>x.replace(/\s+/g,' ').trim());
    if(clean.some(Boolean))out.push(clean);
  }
  return out;
}

async function rowsFromAria(frame){
  const cells=await frame.locator('[aria-rowindex][aria-colindex]').evaluateAll(els=>els.slice(0,30000).map(el=>({
    r:Number(el.getAttribute('aria-rowindex')),c:Number(el.getAttribute('aria-colindex')),
    t:(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()
  })).filter(x=>x.r&&x.c&&x.t)).catch(()=>[]);
  const by=new Map();
  for(const x of cells){if(!by.has(x.r))by.set(x.r,[]);by.get(x.r).push(x);}
  return [...by.entries()].sort((a,b)=>a[0]-b[0]).map(([,xs])=>xs.sort((a,b)=>a.c-b.c).map(x=>x.t));
}

async function scrollAll(frame,page){
  const unique=new Map();
  let stale=0;
  for(let step=0;step<360;step++){
    const roleRows=await rowsFromRole(frame);
    const ariaRows=await rowsFromAria(frame);
    for(const r of [...roleRows,...ariaRows])if(r.some(Boolean))unique.set(r.join('|'),r);
    const before=unique.size;
    const moved=await frame.evaluate(()=>{
      const nodes=[...document.querySelectorAll('*')].filter(x=>x.scrollHeight>x.clientHeight+40&&x.clientHeight>80);
      nodes.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));
      const s=nodes[0];if(!s)return {moved:false,bottom:true};
      const old=s.scrollTop,max=s.scrollHeight-s.clientHeight;
      s.scrollTop=Math.min(max,old+Math.max(180,s.clientHeight*.7));
      s.dispatchEvent(new Event('scroll',{bubbles:true}));
      return {moved:s.scrollTop>old,bottom:s.scrollTop>=max-3};
    }).catch(()=>({moved:false,bottom:false}));
    await page.waitForTimeout(200);
    const after=unique.size;
    stale=after===before?stale+1:0;
    if((moved.bottom&&stale>=4)||stale>=18)break;
  }
  return [...unique.values()];
}

function parseRows(rows,status){
  // find the widest plausible header because Power BI may duplicate header rows
  const headers=rows.filter(r=>r.some(x=>x.includes('Prisområde'))&&r.some(x=>x.includes('(MW)'))).sort((a,b)=>b.length-a.length);
  const header=headers[0];if(!header)return [];
  const idx=n=>header.findIndex(h=>h.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iArea=idx('Prisområde'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iMw=header.findIndex(h=>h.includes('(MW)')),iDate=header.findIndex(h=>h.toLowerCase().includes('dato'));
  if([iArea,iEnd,iIndustry,iMw].some(i=>i<0))return [];
  return rows.filter(r=>r!==header&&r.length>=header.length-2&&r[iArea]&&/^NO\d$/i.test(r[iArea])).map(r=>({
    id:(r[iCase]||r[iTilko]||`${status}-${r[iEnd]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),
    statnett_case:iCase>=0?r[iCase]||null:null,tilko_case:iTilko>=0?r[iTilko]||null:null,station:iStation>=0?r[iStation]||null:null,area_plan:iPlan>=0?r[iPlan]||null:null,area:r[iArea].toUpperCase(),grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:r[iEnd]||null,industry:r[iIndustry]||null,mw:num(r[iMw]),date:iDate>=0?r[iDate]||null:null,status,source:'Statnett'
  })).filter(r=>r.mw!=null&&r.mw>=0);
}

async function extract(config){
  let last;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page}=await openFresh();
    try{
      console.log(`${config.heading}: forsøk ${attempt}/4`);
      const overview=await findOverview(page,config.heading,config.listText);
      if(!overview)throw new Error('oversikts-frame ikke funnet');
      if(!await clickAndVerify(page,overview,config.listText))throw new Error('detaljvisning åpnet ikke');
      await page.waitForTimeout(4000);
      const {best,stats}=await bestDetailCandidate(page);
      if(!best)throw new Error('ingen Power BI-frame etter klikk');
      await fs.writeFile(path.join(RAW,`${config.key}-${day}-frames.json`),JSON.stringify(stats.map(s=>({url:s.url,textLength:s.text.length,rows:s.rows,cells:s.cells,score:s.score})),null,2));
      const rows=await scrollAll(best.frame,page);
      let parsed=parseRows(rows,config.status);
      parsed=parsed.filter(x=>!productionTypes.has(x.industry));
      const scoped=parsed.filter(x=>x.area==='NO1'||x.area==='NO5');
      const mw=scoped.reduce((a,r)=>a+(r.mw||0),0);
      await fs.writeFile(path.join(RAW,`${config.key}-${day}-diagnostic.json`),JSON.stringify({fetched_at:now,attempt,selectedFrame:{url:best.url,score:best.score,textLength:best.text.length,rows:best.rows,cells:best.cells},uniqueRows:rows.length,selectedCount:scoped.length,selectedMw:mw,sample:rows.slice(0,12)},null,2));
      if(!scoped.length||mw<=0)throw new Error(`ingen gyldige NO1/NO5-forbruksrader (rows=${rows.length})`);
      console.log(`${config.heading}: ${scoped.length} saker, ${mw} MW`);
      await context.close();
      return scoped;
    }catch(e){
      last=e;console.error(`${config.heading}: forsøk ${attempt} feilet: ${e.message}`);
      await page.screenshot({path:path.join(RAW,`${config.key}-${day}-v4-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});
      await context.close().catch(()=>{});
      if(attempt<4)await sleep(2000*attempt);
    }
  }
  throw last;
}

async function previous(){try{return JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));}catch{return null;}}
function validate(cur,prev){
  const errors=[];
  for(const kind of ['queue','reservations'])for(const area of ['NO1','NO5']){
    const t=cur.totals[kind][area];if(t.cases<=0||t.mw<=0)errors.push(`${kind} ${area} mangler saker/MW`);
    const old=prev?.totals?.[kind]?.[area]?.mw||0;if(old>100&&t.mw<old*.5)errors.push(`${kind} ${area} falt under 50% av forrige`);
  }
  return errors;
}

const prev=await previous();
console.log('Henter kapasitetskø...');
const queue=await extract({heading:'Kapasitetskø',listText:'Se liste over saker i kapasitetskø',status:'Kapasitetskø',key:'queue'});
console.log('Henter reservasjoner...');
const reservations=await extract({heading:'Reservasjoner',listText:'Se liste over reservasjoner',status:'Reservert',key:'reservations'});

const current={updated_at:now,source:'Statnett – offentlige Power BI-lister',source_url:SOURCE,scope:'Forbruk, NO1 og NO5',queue,reservations,totals:{queue:{NO1:total(queue,'NO1'),NO5:total(queue,'NO5')},reservations:{NO1:total(reservations,'NO1'),NO5:total(reservations,'NO5')}}};
const errors=validate(current,prev);
await fs.writeFile(path.join(RAW,`validation-${day}.json`),JSON.stringify({updated_at:now,ok:!errors.length,errors,totals:current.totals},null,2));
if(errors.length)throw new Error(`Datasett avvist: ${errors.join('; ')}`);
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2));
await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2));
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'));}catch{}
const point={date:day,updated_at:now,queue_NO1:current.totals.queue.NO1.mw,queue_NO5:current.totals.queue.NO5.mw,reserved_NO1:current.totals.reservations.NO1.mw,reserved_NO5:current.totals.reservations.NO5.mw};
history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));
await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2));
console.log('Kvalitetskontroll: OK');
console.log('Ferdig:',JSON.stringify(current.totals));
await browser.close();
