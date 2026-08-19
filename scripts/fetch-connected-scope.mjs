import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd(), DATA=path.join(ROOT,'data'), RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const SOURCE='https://www.statnett.no/for-aktorer-i-kraftbransjen/nettkapasitet-til-produksjon-og-forbruk/foresporsler-og-reservasjon-i-nettet/#tilknyttet-kapasitet';
const now=new Date().toISOString(), day=now.slice(0,10);
const productionTypes=new Set(['Vannkraft','Solkraft','Vindkraft','Kraftproduksjon','Havvind']);
const outsidePlans=new Set(['Helgeland og Salten','Midt','Sør Rogaland og Agder','Nord','Finnmark','Troms','Trøndelag','Sør-Rogaland og Agder']);
const num=s=>{const x=Number(String(s??'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:null};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const total=(rows,area)=>{const a=rows.filter(r=>r.area===area);return {cases:a.length,mw:a.reduce((s,r)=>s+(Number(r.mw)||0),0)}};

let current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));
const votes=new Map();
for(const k of ['queue','reservations','withdrawn','connected']) for(const r of current[k]||[]){
  if(!r.station||!['NO1','NO5'].includes(r.area)) continue;
  const s=String(r.station).trim(); if(!votes.has(s)) votes.set(s,{NO1:0,NO5:0}); votes.get(s)[r.area]++;
}
const stationArea=new Map();
for(const [s,v] of votes){if(v.NO1&&!v.NO5)stationArea.set(s,'NO1');else if(v.NO5&&!v.NO1)stationArea.set(s,'NO5');else if(v.NO1!==v.NO5)stationArea.set(s,v.NO1>v.NO5?'NO1':'NO5')}
// Explicit authoritative overrides for stations whose Statnett area plan spans multiple price areas.
stationArea.set('Flesaker TRA','NO1');

function infer(plan='',station=''){
  const s=String(station||'').trim(); if(stationArea.has(s)) return stationArea.get(s);
  const p=String(plan||'').trim();
  if(['Oslo, Akershus og Østfold','Innlandet','Hallingdal og Ringerike'].includes(p)) return 'NO1';
  if(['Bergen og Haugalandet','Sogn og Sunnmøre'].includes(p)) return 'NO5';
  if(outsidePlans.has(p)) return 'OUT';
  return null;
}

const browser=await chromium.launch({headless:true});
let finalData=null,lastErr=null;
for(let attempt=1;attempt<=4&&!finalData;attempt++){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}}); const page=await context.newPage(); page.setDefaultTimeout(20000);
  try{
    console.log(`Tilknyttet scope: forsøk ${attempt}/4`);
    await page.goto(SOURCE,{waitUntil:'domcontentloaded',timeout:90000}); await page.waitForTimeout(10000);
    let frame=null;
    for(let r=0;r<35&&!frame;r++){for(const f of page.frames().filter(x=>x.url().includes('app.powerbi.com'))){const t=await f.locator('body').innerText({timeout:2500}).catch(()=>'');if(t.includes('Tilknyttet kapasitet')){frame=f;break}}if(!frame)await page.waitForTimeout(800)}
    if(!frame) throw new Error('Power BI-frame ikke funnet');
    for(const loc of [frame.getByText('Se liste over saker med tilknyttet kapasitet',{exact:false}),frame.getByRole('button',{name:/tilknyttet kapasitet/i}),frame.getByRole('link',{name:/tilknyttet kapasitet/i})]){try{if(await loc.count()){await loc.first().click({force:true});await page.waitForTimeout(3000);break}}catch{}}
    let grid=null;
    for(let r=0;r<35&&!grid;r++){const gs=frame.locator('[role="grid"],[role="table"],[role="treegrid"]');for(let i=0;i<await gs.count();i++){const t=await gs.nth(i).innerText({timeout:1500}).catch(()=>'');if(t.includes('Næringstype')&&t.includes('Tilknyttet kapasitet totalt')){grid=gs.nth(i);break}}if(!grid)await page.waitForTimeout(700)}
    if(!grid) throw new Error('detaljtabell ikke funnet');
    const scroll=async(reset=false)=>grid.evaluate((el,reset)=>{const nodes=[el,...el.querySelectorAll('*')];let p=el.parentElement;for(let i=0;i<8&&p;i++,p=p.parentElement)nodes.push(p);const c=[...new Set(nodes)].filter(x=>x.scrollHeight>x.clientHeight+25&&x.clientHeight>40).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight));const s=c[0];if(!s)return {moved:false,bottom:true};if(reset){s.scrollTop=0;return {moved:true,bottom:false}}const before=s.scrollTop,max=s.scrollHeight-s.clientHeight;s.scrollTop=Math.min(max,before+Math.max(140,s.clientHeight*.65));s.dispatchEvent(new Event('scroll',{bubbles:true}));return {moved:s.scrollTop>before,bottom:s.scrollTop>=max-3}},reset).catch(()=>({moved:false,bottom:false}));
    const visible=async()=>{const rs=grid.locator('[role="row"]'),out=[];for(let i=0;i<await rs.count();i++){const cells=await rs.nth(i).locator('[role="gridcell"],[role="columnheader"],[role="rowheader"]').allInnerTexts().catch(()=>[]);const c=cells.map(x=>x.replace(/\s+/g,' ').trim());if(c.some(Boolean))out.push(c)}return out};
    await scroll(true); await page.waitForTimeout(500); const uniq=new Map(); let stale=0,bottom=0;
    for(let step=0;step<500;step++){const before=uniq.size;for(const r of await visible())uniq.set(r.join('|'),r);const s=await scroll(false);await page.waitForTimeout(220);stale=uniq.size===before?stale+1:0;bottom=s.bottom?bottom+1:0;if(bottom>=3&&stale>=3)break;if(stale>=25)break}
    const rows=[...uniq.values()]; const h=rows.find(r=>r.some(x=>x.includes('Næringstype'))&&r.some(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt'))); if(!h)throw new Error('header ikke funnet');
    const idx=n=>h.findIndex(x=>x.toLowerCase().includes(n.toLowerCase()));
    const iCase=idx('Statnett saksnr'),iTilko=idx('Tilko saksnr'),iStation=idx('Stasjon for tilknytning'),iPlan=idx('Områdeplan'),iCustomer=idx('Statnetts kunde'),iEnd=idx('Sluttkunde'),iIndustry=idx('Næringstype'),iDate=h.findIndex(x=>x.toLowerCase().includes('dato')),iMw=h.findIndex(x=>x.toLowerCase().includes('tilknyttet kapasitet totalt')&&x.includes('(MW)'));
    const data=[],unresolved=[],outside=[];
    for(const r of rows.filter(x=>x!==h)){
      const mw=num(r[iMw]),industry=r[iIndustry]||null;if(mw==null||productionTypes.has(industry))continue;
      const station=r[iStation]||null,plan=r[iPlan]||null,area=infer(plan,station);
      const row={id:(r[iCase]||r[iTilko]||`Tilknyttet-${r[iEnd]||r[iCustomer]}-${r[iMw]}`).replace(/[^A-Za-z0-9_-]/g,'-'),statnett_case:r[iCase]||null,tilko_case:r[iTilko]||null,station,area_plan:plan,area,grid_customer:r[iCustomer]||null,end_customer:r[iEnd]||null,industry,mw,date:r[iDate]||null,status:'Tilknyttet',source:'Statnett',area_method:stationArea.has(String(station||'').trim())?'station_map':'area_plan'};
      if(area==='NO1'||area==='NO5')data.push(row);else if(area==='OUT')outside.push(row);else unresolved.push(row);
    }
    const t1=total(data,'NO1'),t5=total(data,'NO5');
    await fs.writeFile(path.join(RAW,`connected-${day}-scope-diagnostic.json`),JSON.stringify({updated_at:now,NO1:t1,NO5:t5,outside_cases:outside.length,outside_mw:outside.reduce((s,x)=>s+x.mw,0),unresolved},null,2));
    if(unresolved.length) throw new Error(`uavklarte prisområder: ${unresolved.length} saker / ${unresolved.reduce((s,x)=>s+x.mw,0)} MW`);
    if(day==='2026-08-19'&&Math.abs(t1.mw-296)>0.01) throw new Error(`NO1 kontrollsum ${t1.mw} MW, forventet 296 MW`);
    finalData=data; console.log(`Tilknyttet validert: NO1 ${t1.cases}/${t1.mw} MW, NO5 ${t5.cases}/${t5.mw} MW`);
    await context.close();
  }catch(e){lastErr=e;console.error(e.message);await page.screenshot({path:path.join(RAW,`connected-${day}-scope-attempt-${attempt}.png`),fullPage:true}).catch(()=>{});await context.close().catch(()=>{});if(attempt<4)await sleep(2000*attempt)}
}
await browser.close(); if(!finalData)throw lastErr||new Error('ingen gyldige tilknyttet-data');
const t1=total(finalData,'NO1'),t5=total(finalData,'NO5');
current.connected=finalData; current.status_meta ||= {}; current.status_meta.connected={ok:true,fresh:true,updated_at:now,error:null,preserved_previous:false,area_resolution:{station_or_plan:finalData.length}}; current.totals ||= {}; current.totals.connected={NO1:t1,NO5:t5}; current.updated_at=now;
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{};let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;point.connected_NO1=t1.mw;point.connected_NO5=t5.mw;history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
console.log('TILKNYTTET SCOPE VALIDERT');
