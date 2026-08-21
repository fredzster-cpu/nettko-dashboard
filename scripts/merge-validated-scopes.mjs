import fs from 'fs/promises';
import path from 'path';
const ROOT=process.cwd(),DATA=path.join(ROOT,'data'),STAGE=path.join(DATA,'staging'),SNAP=path.join(DATA,'snapshots');
await fs.mkdir(SNAP,{recursive:true});
const areas=['NO1','NO2','NO3','NO4','NO5'],keys=['queue','reservations','connected','withdrawn'],now=new Date().toISOString(),day=now.slice(0,10);
let current={};try{current=JSON.parse(await fs.readFile(path.join(DATA,'current.json'),'utf8'))}catch{}
current.status_meta ||= {};current.totals ||= {};current.statnett_display_totals ||= {};
const report={updated_at:now,areas:{},published:[],preserved:[],missing:[]};
for(const a of areas)report.areas[a]={};
for(const k of keys){
  const previous=Array.isArray(current[k])?current[k]:[];
  let merged=previous.filter(r=>!areas.includes(r.area));
  current.status_meta[k] ||= {};
  current.status_meta[k].areas ||= {};
  current.totals[k] ||= {};
  current.statnett_display_totals[k] ||= {};
  for(const a of areas){
    let staged=null,err=null;
    try{staged=JSON.parse(await fs.readFile(path.join(STAGE,`${k}-${a}.json`),'utf8'))}catch{}
    try{err=JSON.parse(await fs.readFile(path.join(STAGE,`${k}-${a}.error.json`),'utf8'))}catch{}
    const prevRows=previous.filter(r=>r.area===a);
    if(staged?.ok&&Array.isArray(staged.rows)){
      merged.push(...staged.rows);
      current.totals[k][a]={cases:staged.cases,mw:staged.row_mw};
      current.statnett_display_totals[k][a]=staged.kpi_mw;
      current.status_meta[k].areas[a]={ok:true,fresh:true,updated_at:staged.updated_at,error:null,preserved_previous:false,validated_against_statnett_kpi:true};
      report.areas[a][k]={state:'published',cases:staged.cases,mw:staged.row_mw,kpi:staged.kpi_mw};report.published.push(`${k}:${a}`);
    }else if(prevRows.length){
      merged.push(...prevRows);
      const mw=prevRows.reduce((s,r)=>s+(Number(r.mw)||0),0);
      current.totals[k][a]={cases:prevRows.length,mw};
      current.status_meta[k].areas[a]={ok:false,fresh:false,updated_at:current.status_meta[k].areas[a]?.updated_at||current.status_meta[k].updated_at||null,error:err?.error||'ny validering mangler',preserved_previous:true,validated_against_statnett_kpi:false};
      report.areas[a][k]={state:'preserved',cases:prevRows.length,mw,error:err?.error||null};report.preserved.push(`${k}:${a}`);
    }else{
      current.totals[k][a]={cases:0,mw:0};
      current.status_meta[k].areas[a]={ok:false,fresh:false,updated_at:null,error:err?.error||'ingen validert historikk',preserved_previous:false,validated_against_statnett_kpi:false};
      report.areas[a][k]={state:'missing',cases:0,mw:0,error:err?.error||null};report.missing.push(`${k}:${a}`);
    }
  }
  current[k]=merged;
  const areaStates=areas.map(a=>current.status_meta[k].areas[a]);
  current.status_meta[k].ok=areaStates.every(x=>x.ok||x.preserved_previous);
  current.status_meta[k].fresh=areaStates.every(x=>x.fresh);
  current.status_meta[k].updated_at=now;
  current.status_meta[k].error=areaStates.filter(x=>!x.fresh).map((x,i)=>!x.fresh?areas[i]+': '+(x.error||'ikke fersk'):null).filter(Boolean).join('; ')||null;
}
current.updated_at=now;current.scope='Forbruk, NO1–NO5 – områdevis validering';
await fs.writeFile(path.join(DATA,'current.json'),JSON.stringify(current,null,2)+'\n');
let history=[];try{history=JSON.parse(await fs.readFile(path.join(DATA,'history.json'),'utf8'))}catch{}
let point=history.find(x=>x.date===day)||{date:day};point.updated_at=now;
for(const k of keys)for(const a of areas){const meta=current.status_meta[k]?.areas?.[a];point[`${k}_${a}`]=meta?.fresh?current.totals[k][a].mw:null;}
history=history.filter(x=>x.date!==day);history.push(point);history.sort((a,b)=>a.date.localeCompare(b.date));await fs.writeFile(path.join(DATA,'history.json'),JSON.stringify(history,null,2)+'\n');
await fs.writeFile(path.join(SNAP,`${day}.json`),JSON.stringify(current,null,2)+'\n');
await fs.writeFile(path.join(DATA,'scope-validation-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
