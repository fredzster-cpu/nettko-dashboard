import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const no1Plans=new Set(['Oslo, Akershus og Østfold','Innlandet','Hallingdal og Ringerike']);
const no5Plans=new Set(['Bergen og Haugalandet','Sogn og Sunnmøre']);
const outsidePlans=new Set(['Helgeland og Salten','Midt','Sør Rogaland og Agder','Sør-Rogaland og Agder','Nord','Finnmark','Troms','Trøndelag','Telemark og Vestfold']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const num=s=>{const x=Number(String(s??'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const total=rows=>({cases:rows.length,mw:rows.reduce((s,r)=>s+(Number(r.mw)||0),0)});

let current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));

const votes=new Map();
for(const k of ['queue','reservations','withdrawn']) for(const r of current[k]||[]){
  if(!r.station||!['NO1','NO5'].includes(r.area)) continue;
  const s=clean(r.station); if(!votes.has(s)) votes.set(s,{NO1:0,NO5:0}); votes.get(s)[r.area]++;
}
const stationArea=new Map();
for(const [s,v] of votes){
  if(v.NO1&&!v.NO5) stationArea.set(s,'NO1');
  else if(v.NO5&&!v.NO1) stationArea.set(s,'NO5');
  else if(v.NO1!==v.NO5) stationArea.set(s,v.NO1>v.NO5?'NO1':'NO5');
}
// Verified boundary case: Statnett's NO1-filtered connected view contains Flesaker
// cases even when their area plan is Telemark og Vestfold.
stationArea.set('Flesaker TRA','NO1');

function inferArea(plan='',station=''){
  const s=clean(station), p=clean(plan);
  if(s==='Flesaker TRA') return 'NO1';
  // The area plan is normally more reliable than a station vote. Some stations occur
  // in cases from multiple price areas; station-first classification leaked non-NO5
  // rows into NO5. Use station mapping only when the plan is not decisive.
  if(no1Plans.has(p)) return 'NO1';
  if(no5Plans.has(p)) return 'NO5';
  if(outsidePlans.has(p)) return 'OUT';
  if(stationArea.has(s)) return stationArea.get(s);
  return null;
}
function areaMethod(plan='',station=''){
  const s=clean(station),p=clean(plan);
  if(s==='Flesaker TRA') return 'station_override';
  if(no1Plans.has(p)||no5Plans.has(p)||outsidePlans.has(p)) return 'area_plan';
  if(stationArea.has(s)) return 'station_map';
  return 'unresolved';
}

function parseForbruk(body){
  const lines=body.split(/\r?\n/).map(clean).filter(Boolean);
  const h=lines.findIndex(x=>x==='Tilknyttet kapasitet');
  for(let i=Math.max(0,h);i<Math.min(lines.length,Math.max(0,h)+90);i++){
    if(lines[i]==='Forbruk (MW)'){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(lines[j])) break;
        const v=num(lines[j]); if(v!=null&&v>=0) return v;
      }
    }
  }
  throw new Error('Forbruk-KPI ikke funnet');
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

async function openReport(){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(9000);
  let frame=null;
  for(let r=0;r<35&&!frame;r++){
    for(const f of page.frames()){
      const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(t.includes('Tilknyttet kapasitet')&&t.includes('Prisområde')){frame=f;break}
    }
    if(!frame) await page.waitForTimeout(700);
  }
  if(!frame){await context.close();throw new Error('rapport-frame ikke funnet')}
  return {context,page,frame};
}

async function readAreaKpi(area){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await openReport();
    try{
      if(!await chooseArea(frame,page,area)) throw new Error(`klarte ikke velge Prisområde=${area}`);
      const body=await frame.locator('body').innerText(); const kpi=parseForbruk(body);
      await fs.writeFile(path.join(RAW,`connected-kpi-${area}-${day}.txt`),body);
      console.log(`Tilknyttet Statnett KPI ${area}: ${kpi} MW`);
      await context.close(); return kpi;
    }catch(e){lastErr=e;await context.close().catch(()=>{});if(attempt<4)await sleep(1500*attempt)}
  }
  throw lastErr;
}

async function collectGrid(grid,page){
  const visible=async()=>{const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);const c=cells.map(clean);if(c.some(Boolean))out.push(c)}return out};
  const scroll=async(reset=false)=>grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const cs=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=cs[0];if(!s)return {moved:false,bottom:true};if(reset){s.scrollTop=0;return {moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65));s.dispatchEvent(new Event('scroll',{bubbles:true}));return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}));
  await scroll(true); await page.waitForTimeout(500); const uniq=new Map();let stale=0,bottom=0;
  for(let step=0;step<500;step++){const before=uniq.size;for(const r of await visible())uniq.set(r.join('|'),r);const s=await scroll(false);await page.waitForTimeout(220);stale=uniq.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break}
  return [...uniq.values()];
}

function parseRows(rows){
  const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt'))); if(!h)return {data:[],outside:[],unresolved:[]};
  const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
  const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
  const data=[],outside=[],unresolved=[];
  for(const r of rows.filter(x=>x!==h)){
    const mw=num(r[iMw]),industry=r[iIndustry]||null; if(mw==null||productionTypes.has(industry)) continue;
    const statnettCase=iCase>=0?r[iCase]||null:null,station=iStation>=0?r[iStation]||null:null,plan=iPlan>=0?r[iPlan]||null:null;
    // Power BI includes a grand-total row. It must never become a project case.
    if(clean(statnettCase).toLowerCase()==='totalt') continue;
    if(!statnettCase && !(iEnd>=0?r[iEnd]:null) && !(iCustomer>=0?r[iCustomer]:null)) continue;
    const area=inferArea(plan,station);
    const row={id:(statnettCase||(iTilko>=0?r[iTilko]:null)||`Tilknyttet-${station}-${iEnd>=0?r[iEnd]:''}-${mw}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:statnettCase,tilko_case:iTilko>=0?r[iTilko]||null:null,station,area_plan:plan,area,grid_customer:iCustomer>=0?r[iCustomer]||null:null,end_customer:iEnd>=0?r[iEnd]||null:null,industry,mw,date:iDate>=0?r[iDate]||null:null,status:'Tilknyttet',source:'Statnett',area_method:areaMethod(plan,station)};
    if(area==='NO1'||area==='NO5') data.push(row); else if(area==='OUT') outside.push(row); else unresolved.push(row);
  }
  return {data,outside,unresolved};
}

async function readAllDetails(){
  let lastErr;
  for(let attempt=1;attempt<=4;attempt++){
    const {context,page,frame}=await openReport();
    try{
      const link=frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false}); if(!(await link.count()))throw new Error('detaljlenke ikke funnet');
      await link.first().click({force:true}); await page.waitForTimeout(3500);
      let grid=null;for(let r=0;r<35&&!grid;r++){const gs=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');for(let i=0;i<await gs.count();i++){const t=await gs.nth(i).innerText({timeout:1500}).catch(()=>'');if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')){grid=gs.nth(i);break}}if(!grid)await page.waitForTimeout(700)}
      if(!grid) throw new Error('detaljtabell ikke funnet');
      const raw=await collectGrid(grid,page); const parsed=parseRows(raw);
      await context.close(); return parsed;
    }catch(e){lastErr=e;await context.close().catch(()=>{});if(attempt<4)await sleep(1500*attempt)}
  }
  throw lastErr;
}

const browser=await chromium.launch({headless:true});
const kpiNO1=await readAreaKpi('NO1');
const kpiNO5=await readAreaKpi('NO5');
const parsed=await readAllDetails();
await browser.close();

const knownNO1=total(parsed.data.filter(r=>r.area==='NO1'));
const knownNO5=total(parsed.data.filter(r=>r.area==='NO5'));
await fs.writeFile(path.join(RAW,`connected-${day}-classification-diagnostic.json`),JSON.stringify({updated_at:now,kpi:{NO1:kpiNO1,NO5:kpiNO5},candidate:{NO1:knownNO1,NO5:knownNO5},outside:total(parsed.outside),unresolved:parsed.unresolved},null,2));
if(parsed.unresolved.length){
  if(Math.round(knownNO1.mw)===Math.round(kpiNO1) && Math.round(knownNO5.mw)===Math.round(kpiNO5)){
    console.log(`Tilknyttet: ${parsed.unresolved.length} uavklarte landsrader ekskluderes fra NO1/NO5 fordi klassifiserte rader matcher Statnetts KPI-er nøyaktig`);
    parsed.outside.push(...parsed.unresolved.map(r=>({...r,area:'OUT',area_method:'excluded_by_kpi_balance'})));
    parsed.unresolved.length=0;
  } else {
    throw new Error(`Tilknyttet har ${parsed.unresolved.length} uavklarte saker / ${total(parsed.unresolved).mw} MW; kjente rader NO1 ${knownNO1.mw}/${kpiNO1}, NO5 ${knownNO5.mw}/${kpiNO5}`);
  }
}

const no1=parsed.data.filter(r=>r.area==='NO1'),no5=parsed.data.filter(r=>r.area==='NO5');
const t1=total(no1),t5=total(no5);
await fs.writeFile(path.join(RAW,`connected-${day}-validated-diagnostic.json`),JSON.stringify({updated_at:now,kpi:{NO1:kpiNO1,NO5:kpiNO5},rows:{NO1:t1,NO5:t5},outside:total(parsed.outside),station_map_size:stationArea.size,unresolved:parsed.unresolved},null,2));
if(Math.round(t1.mw)!==Math.round(kpiNO1)) throw new Error(`Tilknyttet NO1 radtotal ${t1.mw} MW matcher ikke Statnett KPI ${kpiNO1} MW`);
if(Math.round(t5.mw)!==Math.round(kpiNO5)) throw new Error(`Tilknyttet NO5 radtotal ${t5.mw} MW matcher ikke Statnett KPI ${kpiNO5} MW`);

const rows=[...no1,...no5];
const ids=new Set();for(const r of rows){const k=`${r.area}|${r.id}`;if(ids.has(k))throw new Error(`duplikat ${k}`);ids.add(k)}
current.connected=rows;
current.status_meta ||= {};
current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{station_or_plan:rows.length},validated_against_statnett_kpi:true};
current.totals ||= {};
current.totals.connected={NO1:t1,NO5:t5};
current.statnett_display_totals ||= {};
current.statnett_display_totals.connected={NO1:kpiNO1,NO5:kpiNO5};
current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
console.log('TILKNYTTET VALIDERT MOT STATNETT KPI',JSON.stringify({NO1:t1,NO5:t5,kpi:{NO1:kpiNO1,NO5:kpiNO5}}));
