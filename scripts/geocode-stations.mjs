import fs from 'node:fs/promises';

const CURRENT='data/current.json';
const OUT='data/stations.json';
const NVE_STATIONS='https://kart.nve.no/enterprise/rest/services/Nettanlegg4/FeatureServer/5/query';
const NVE_LINES='https://kart.nve.no/enterprise/rest/services/Nettanlegg4/FeatureServer/0/query';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function cleanName(name=''){
  return name
    .replace(/\s+(KRA\s*\/\s*TRA|TRA\s*\/\s*KRA)\s*$/i,'')
    .replace(/\s+(TRA|KRA|SE)\s*$/i,'')
    .replace(/\s+transformatorstasjon\s*$/i,'')
    .trim();
}
function norm(s=''){
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9æøå]+/g,' ').trim();
}
function validCoord(x){return Number.isFinite(Number(x?.lat))&&Number.isFinite(Number(x?.lon));}
function sqlEscape(s){return String(s).replace(/'/g,"''");}

async function queryJson(url,params){
  const u=new URL(url);
  for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  const r=await fetch(u,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(`NVE ${r.status}`);
  const j=await r.json();
  if(j.error)throw new Error(`NVE API: ${j.error.message||'ukjent feil'}`);
  return j.features||[];
}

async function nveQuery(base){
  const token=cleanName(base).split(/\s+/)[0];
  return queryJson(NVE_STATIONS,{
    where:`nvenettnivaa = '1' AND navn LIKE '%${sqlEscape(token)}%'`,
    outFields:'objectid,navn,eier,nvenettnivaa,spenning_kv,nvenetbasid',returnGeometry:'true',outSR:'4326',f:'json'
  });
}

async function nearbyTransmissionVoltages(lon,lat){
  // NVE's station layer frequently has spenning_kv=null. Resolve voltage from
  // transmission-line assets physically connected to/near the verified station.
  const features=await queryJson(NVE_LINES,{
    where:'1=1',
    geometry:`${lon},${lat}`,
    geometryType:'esriGeometryPoint',
    inSR:'4326',spatialRel:'esriSpatialRelIntersects',distance:'1500',units:'esriSRUnit_Meter',
    outFields:'spenning_kv,navn,eier,nvenettnivaa',returnGeometry:'false',f:'json'
  });
  return [...new Set(features.map(f=>Number(f.attributes?.spenning_kv)).filter(v=>Number.isFinite(v)&&v>0))].sort((a,b)=>b-a);
}

function scoreFeature(f,base){
  const a=f.attributes||{};
  const n=norm(a.navn),b=norm(base);
  let s=0;
  if(n===b)s+=100;
  if(n.startsWith(b)||b.startsWith(n))s+=50;
  const bt=b.split(' ').filter(Boolean),nt=n.split(' ').filter(Boolean);
  s+=bt.filter(x=>nt.includes(x)).length*10;
  if(norm(a.eier).includes('statnett'))s+=25;
  if(String(a.nvenettnivaa)==='1')s+=20;
  return s;
}

async function locate(station){
  const base=cleanName(station);
  const features=await nveQuery(base);
  const candidates=features
    .filter(f=>Number.isFinite(Number(f.geometry?.x))&&Number.isFinite(Number(f.geometry?.y)))
    .map(f=>({f,score:scoreFeature(f,base)}))
    .sort((a,b)=>b.score-a.score);
  const best=candidates[0];
  if(!best||best.score<30)return null;
  const a=best.f.attributes||{},g=best.f.geometry||{};
  const direct=Number(a.spenning_kv);
  let voltages=Number.isFinite(direct)&&direct>0?[direct]:[];
  let voltageSource='NVE transformatorstasjon';
  if(!voltages.length){
    try{
      voltages=await nearbyTransmissionVoltages(Number(g.x),Number(g.y));
      voltageSource=voltages.length?'NVE transmisjonslinjer ved stasjonen':'NVE – ikke funnet';
    }catch(e){
      console.warn(`  -> spenningsoppslag feilet: ${e.message}`);
    }
  }
  return {
    station,base,lat:Number(g.y),lon:Number(g.x),
    display_name:a.navn||base,owner:a.eier||null,
    voltage_kv:voltages[0]??null,
    voltage_levels_kv:voltages,
    voltage_source:voltageSource,
    nve_netbas_id:a.nvenetbasid??null,nve_object_id:a.objectid??null,
    confidence:best.score>=100?'verified':'high',source:'NVE Nettanlegg4',checked_at:new Date().toISOString()
  };
}

const current=JSON.parse(await fs.readFile(CURRENT,'utf8'));
const rows=['queue','reservations','connected','withdrawn'].flatMap(k=>Array.isArray(current[k])?current[k]:[]);
const stations=[...new Set(rows.map(x=>x.station).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'nb'));
const cache={updated_at:null,source:'NVE Nettanlegg4',stations:{}};
for(const station of stations){
  console.log(`NVE-sjekk: ${station}`);
  try{
    const found=await locate(station);
    if(found){cache.stations[station]=found;console.log(`  -> ${found.display_name}: ${found.lat}, ${found.lon}; ${found.voltage_levels_kv?.join('/')||'?'} kV`);}
    else cache.stations[station]={station,base:cleanName(station),lat:null,lon:null,voltage_kv:null,voltage_levels_kv:[],confidence:'unresolved',source:'NVE Nettanlegg4',checked_at:new Date().toISOString()};
  }catch(e){
    console.warn(`  -> NVE-oppslag feilet: ${e.message}`);
    cache.stations[station]={station,base:cleanName(station),lat:null,lon:null,voltage_kv:null,voltage_levels_kv:[],confidence:'unresolved',source:'NVE Nettanlegg4',checked_at:new Date().toISOString(),error:e.message};
  }
  await sleep(100);
}
cache.updated_at=new Date().toISOString();cache.station_count=stations.length;
cache.resolved_count=stations.filter(s=>validCoord(cache.stations[s])).length;
cache.voltage_resolved_count=stations.filter(s=>(cache.stations[s]?.voltage_levels_kv||[]).length).length;
cache.unresolved_count=cache.station_count-cache.resolved_count;
await fs.mkdir('data',{recursive:true});
await fs.writeFile(OUT,JSON.stringify(cache,null,2)+'\n');
console.log(`Stasjoner: ${cache.resolved_count}/${cache.station_count} koordinatfestet; ${cache.voltage_resolved_count}/${cache.station_count} med spenningsnivå.`);
