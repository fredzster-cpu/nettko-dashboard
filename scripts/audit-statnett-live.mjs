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

// Audit every KPI against the exact Statnett report that owns that status.
// Do not infer queue/reservations from another report: the public Power BI pages
// have changed layout over time and each status now has a stable dedicated view.
const reports={
  queue:{
    url:'https://app.powerbi.com/view?pageName=e919fd623fe16c1f1b5b&r=eyJrIjoiYTM4N2MzZGMtMGMwYi00MjMwLThjNWYtYTBhMmNkYTVkNmFmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Kapasitetskø',
    markers:['Prisområde','Kapasitetskø','Forbruk (MW)']
  },
  reservations:{
    url:'https://app.powerbi.com/view?pageName=ccba661604c0f2acf1b4&r=eyJrIjoiZTVkMmNiNDQtM2VhZi00OGQ0LWE0YTAtMjMyOGMxMzhlYmZmIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Reservasjoner',
    markers:['Prisområde','Reservasjoner','Forbruk (MW)']
  },
  connected:{
    url:'https://app.powerbi.com/view?pageName=4e3c7301c82c9e197db5&r=eyJrIjoiNmE3ZDVhMzEtNjgwNi00MDQ2LTkyMDEtNzFmYjU3MDkzNDIyIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Tilknyttet kapasitet',
    markers:['Prisområde','Tilknyttet kapasitet','Forbruk (MW)']
  },
  withdrawn:{
    url:'https://app.powerbi.com/view?r=eyJrIjoiZjhkMjM1OWQtMDBlYS00NDUzLWE4YTMtNjA4YmYzMWQ2MDFlIiwidCI6ImE4ZDYxNDYyLWYyNTItNDRiMi1iZjZhLWQ3MjMxOTYwYzA0MSIsImMiOjh9',
    heading:'Tilbaketrukket kapasitet',
    markers:['Prisområde','Tilbaketrukket kapasitet','Forbruk (MW)']
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

function frameMatches(txt,cfg){
  const t=clean(txt);
  if(t.includes(cfg.heading) && t.includes('Forbruk (MW)')) return true;
  return (cfg.markers||[]).every(m=>t.includes(m));
}

async function openReport(cfg,key){
  const context=await browser.newContext({locale:'nb-NO',viewport:{width:1920,height:1400}});
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(cfg.url,{waitUntil:'domcontentloaded',timeout:90000});
  await page.waitForTimeout(9000);
  let frame=null,best=null;
  for(let i=0;i<40&&!frame;i++){
    for(const f of page.frames()){
      const txt=await f.locator('body').innerText({timeout:2500}).catch(()=>'');
      if(!txt) continue;
      if(frameMatches(txt,cfg)){frame=f;break;}
      if(txt.includes('Prisområde')&&txt.includes('Forbruk (MW)')&&(!best||txt.length>best.txt.length)) best={f,txt};
    }
    if(!frame) await page.waitForTimeout(700);
  }
  if(!frame&&best) frame=best.f;
  if(!frame){
    await page.screenshot({path:path.join(RAW,`audit-open-failed-${key}-${day}.png`),fullPage:true}).catch(()=>{});
    throw new Error(`Power BI-frame ikke funnet for ${cfg.heading}`);
  }
  return {context,page,frame};
}

async function chooseArea(frame,page,area){
  // First handle already-selected slicer (important when the browser retained a Power BI state).
  const bodyBefore=clean(await frame.locator('body').innerText({timeout:2500}).catch(()=>''));
  const linesBefore=bodyBefore.split(/\r?\n/).map(clean).filter(Boolean);
  const pidx=linesBefore.findIndex(x=>x==='Prisområde');
  if(pidx>=0 && linesBefore.slice(pidx+1,pidx+5).includes(area)) return true;

  const labels=frame.getByText('Prisområde',{exact:true});
  const n=await labels.count().catch(()=>0);
  for(let i=0;i<n;i++){
    let node=labels.nth(i);
    for(let up=0;up<7;up++){
      try{
        const txt=clean(await node.innerText({timeout:1000}));
        if(txt.includes('Prisområde')){
          for(const currentLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
            const cur=node.getByText(currentLabel,{exact:true});
            if(!(await cur.count())) continue;
            await cur.first().click({force:true}); await page.waitForTimeout(700);
            const opts=frame.getByText(area,{exact:true});
            if(await opts.count()){
              await opts.last().click({force:true}); await page.waitForTimeout(2500);
              return true;
            }
          }
        }
      }catch{}
      node=node.locator('xpath=..');
    }
  }
  // Last fallback: click a visible current slicer value whose ancestor contains Prisområde.
  for(const currentLabel of ['Alle','NO1','NO2','NO3','NO4','NO5']){
    const vals=frame.getByText(currentLabel,{exact:true});
    for(let i=0;i<await vals.count().catch(()=>0);i++){
      const node=vals.nth(i);
      try{
        let p=node,hit=false;
        for(let up=0;up<7;up++){p=p.locator('xpath=..');const txt=clean(await p.innerText({timeout:700}));if(txt.includes('Prisområde')){hit=true;break;}}
        if(!hit) continue;
        if(currentLabel===area) return true;
        await node.click({force:true}); await page.waitForTimeout(700);
        const opt=frame.getByText(area,{exact:true});
        if(await opt.count()){await opt.last().click({force:true});await page.waitForTimeout(2500);return true;}
      }catch{}
    }
  }
  return false;
}

function parseSingleForbruk(body,heading){
  const lines=body.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const headingIndex=lines.findIndex(x=>clean(x).toLowerCase().includes(clean(heading).toLowerCase()));
  const start=headingIndex>=0?headingIndex:0;
  for(let i=start;i<Math.min(lines.length,start+220);i++){
    if(clean(lines[i]).toLowerCase()==='forbruk (mw)'){
      // Power BI may put axis tick labels after the title; KPI cards put the value immediately after it.
      // Prefer the first numeric token before another semantic label, excluding obvious axis zeros.
      for(let j=i+1;j<Math.min(lines.length,i+14);j++){
        const l=clean(lines[j]);
        if(['Produksjon (MW)','Næringstype','Prisområde','Områdeplan'].includes(l)) break;
        const v=parseNum(l);
        if(v!=null && v>0) return v;
      }
    }
  }
  throw new Error(`Kunne ikke lese Forbruk (MW) for ${heading}`);
}

async function auditStatus(key,cfg,area){
  const {context,page,frame}=await openReport(cfg,key);
  try{
    const ok=await chooseArea(frame,page,area);
    if(!ok) throw new Error(`Kunne ikke sette Prisområde=${area} for ${cfg.heading}`);
    const body=await frame.locator('body').innerText();
    await fs.writeFile(path.join(RAW,`audit-${key}-${area}-${day}.txt`),body);
    return parseSingleForbruk(body,cfg.heading);
  } finally {
    await context.close().catch(()=>{});
  }
}

const source={NO1:{},NO5:{}};
for(const area of ['NO1','NO5']){
  for(const key of ['queue','reservations','connected','withdrawn']){
    source[area][key]=await auditStatus(key,reports[key],area);
  }
}

const audit={updated_at:now,source,checks:[],ok:true};
for(const area of ['NO1','NO5']){
  for(const key of ['queue','reservations','connected','withdrawn']){
    const rows=current[key]||[];
    const rowMw=sum(rows,area);
    const rowCases=count(rows,area);
    const displayed=source[area][key];
    // Statnett overview cards display whole MW. Compare exactly at display precision.
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
console.log('STATNETT LIVE AUDIT OK – alle åtte KPI-MW samsvarer med Statnett');
