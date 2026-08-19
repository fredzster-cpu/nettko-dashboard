import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const ROOT=process.cwd();
const DATA=path.join(ROOT,'data');
const RAW=path.join(DATA,'raw');
await fs.mkdir(RAW,{recursive:true});
const now=new Date().toISOString();
const day=now.slice(0,10);
const current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'));

const reports={
  queueReservations:{
    url:'https://app.powerbi.com/view?pageName=e919fd623fe16c1f1b5b&r=eyJrIjoiYTM4N2MzZGMtMGMwYi00MjMwLThjNWYtYTBhMmNkYTVkNmFmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Historisk høyeste forbruk og produksjon'
  },
  connected:{
    url:'https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Tilknyttet kapasitet'
  },
  withdrawn:{
    url:'https://app.powerbi.com/view?r=eyJrIjoiZjhkMjM1OWQtMDBlYS00NDUzLWE4YTMtNjA4YmYzMWQ2MDFlIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Tilbaketrukket kapasitet'
  }
};

const clean=s=>String(s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const parseNum=s=>{
  const x=Number(String(s||'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));
  return Number.isFinite(x)?x:null;
};
const sum=(rows,area)=>rows.filter(r=>r.area===area).reduce((s,r)=>s+(Number(r.mw)||0),0);
const count=(rows,area)=>rows.filter(r=>r.area===area).length;

const browser=await chromium.launch({headless:true});

async function openReport(cfg){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(9000);
  let frame=null;
  for(let i=0;i<30&&!frame;i++){
    for(const f of page.frames()){
      const txt=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(txt.includes(cfg.heading)){frame=f;break;}
    }
    if(!frame) await page.waitForTimeout(700);
  }
  if(!frame) throw new Error(`Power BI-frame ikke funnet for ${cfg.heading}`);
  return {context,page,frame};
}

async function chooseArea(frame,page,area){
  // Locate the slicer by walking upward from the Prisområde label.
  const labels=frame.getByText('Prisområde',{exact:true});
  const n=await labels.count().catch(()=>0);
  for(let i=0;i<n;i++){
    let node=labels.nth(i);
    for(let up=0;up<5;up++){
      try{
        const txt=clean(await node.innerText({timeout:1000}));
        if(txt.includes('Prisområde')){
          const all=node.getByText('Alle',{exact:true});
          if(await all.count()){
            await all.first().click({force:true});
            await page.waitForTimeout(600);
            const opt=frame.getByText(area,{exact:true});
            if(await opt.count()){
              await opt.last().click({force:true});
              await page.waitForTimeout(2200);
              return true;
            }
          }
        }
      }catch{}
      node=node.locator('xpath=..');
    }
  }
  return false;
}

function parseQueueReservations(body){
  // The consumption overview contains: Historisk maks helelandet / Reservert kapasitet / Kapasitet i kø / values.
  const lines=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<lines.length-6;i++){
    if(clean(lines[i]).toLowerCase().includes('historisk maks helelandet') && clean(lines[i+1]).toLowerCase().includes('reservert kapasitet') && clean(lines[i+2]).toLowerCase().includes('kapasitet i kø')){
      const hist=parseNum(lines[i+3]),res=parseNum(lines[i+4]),queue=parseNum(lines[i+5]);
      if(hist!=null&&res!=null&&queue!=null) return {reservations:res,queue};
    }
  }
  throw new Error('Kunne ikke lese oversiktstall for kø/reservasjoner');
}

function parseSingleForbruk(body,heading){
  const lines=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const headingIndex=lines.findIndex(x=>clean(x).toLowerCase().includes(clean(heading).toLowerCase()));
  const start=headingIndex>=0?headingIndex:0;
  for(let i=start;i<Math.min(lines.length,start+120);i++){
    if(clean(lines[i]).toLowerCase()==='forbruk (mw)'){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        const v=parseNum(lines[j]);
        if(v!=null) return v;
      }
    }
  }
  throw new Error(`Kunne ikke lese Forbruk (MW) for ${heading}`);
}

async function auditOverview(key,cfg,area){
  const {context,page,frame}=await openReport(cfg);
  try{
    const ok=await chooseArea(frame,page,area);
    if(!ok) throw new Error(`Kunne ikke sette Prisområde=${area} for ${cfg.heading}`);
    const body=await frame.locator('body').innerText();
    await fs.writeFile(path.join(RAW,`audit-${key}-${area}-${day}.txt`),body);
    if(key==='queueReservations') return parseQueueReservations(body);
    return parseSingleForbruk(body,cfg.heading);
  } finally {
    await context.close().catch(()=>{});
  }
}

const source={NO1:{},NO5:{}};
for(const area of ['NO1','NO5']){
  const qr=await auditOverview('queueReservations',reports.queueReservations,area);
  source[area].queue=qr.queue;
  source[area].reservations=qr.reservations;
  source[area].connected=await auditOverview('connected',reports.connected,area);
  source[area].withdrawn=await auditOverview('withdrawn',reports.withdrawn,area);
}

const audit={updated_at:now,source,checks:[],ok:true};
for(const area of ['NO1','NO5']){
  for(const key of ['queue','reservations','connected','withdrawn']){
    const rows=current[key]||[];
    const rowMw=sum(rows,area);
    const rowCases=count(rows,area);
    const displayed=source[area][key];
    // Statnett summary cards are shown as whole MW. Compare the same representation used in the dashboard KPI.
    const rowDisplayed=Math.round(rowMw);
    const ok=rowDisplayed===Math.round(displayed);
    audit.checks.push({key,area,statnett_mw:displayed,row_mw:rowMw,row_displayed_mw:rowDisplayed,cases:rowCases,ok});
    if(!ok) audit.ok=false;
  }
}

await fs.writeFile(path.join(DATA,'statnett-audit.json'),JSON.stringify(audit,null,2)+'\n');
await fs.writeFile(path.join(RAW,`statnett-live-audit-${day}.json`),JSON.stringify(audit,null,2)+'\n');
console.log(JSON.stringify(audit,null,2));
await browser.close();
if(!audit.ok){
  const bad=audit.checks.filter(x=>!x.ok).map(x=>`${x.key} ${x.area}: dashboard ${x.row_displayed_mw} vs Statnett ${x.statnett_mw}`).join('; ');
  throw new Error(`STATNETT AUDIT FEILET: ${bad}`);
}
console.log('STATNETT LIVE AUDIT OK – alle KPI-MW samsvarer med Statnett');
