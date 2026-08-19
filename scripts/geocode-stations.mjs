import fs from 'node:fs/promises';

const CURRENT='data/current.json';
const OUT='data/stations.json';
const NVE='https://kart.nve.no/enterprise/rest/services/Nettanlegg4/FeatureServer/5/query';
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

async function nveQuery(base){
  const u=new URL(NVE);
  const token=cleanName(base).split(/\s+/)[0];
  u.searchParams.set('where',`nvenettnivaa = '1' AND navn LIKE '%${sqlEscape(token)}%'`);
  u.searchParams.set('outFields','objectid,navn,eier,nvenettnivaa,spenning_kv,nvenetbasid');
  u.searchParams.set('returnGeometry','true');
  u.searchParams.set('outSR','4326');
  u.searchParams.set('f','json');
  const r=await fetch(u,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(`NVE ${r.status}`);
  const j=await r.json();
  if(j.error)throw new Error(`NVE API: ${j.error.message||'ukjent feil'}`);
  return j.features||[];
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
  return {
    station,base,lat:Number(g.y),lon:Number(g.x),
    display_name:a.navn||base,
    owner:a.eier||null,
    voltage_kv:a.spenning_kv??null,
    nve_netbas_id:a.nvenetbasid??null,
    nve_object_id:a.objectid??null,
    confidence:best.score>=100?'verified':'high',
    source:'NVE Nettanlegg4 / Transformatorstasjoner',
    checked_at:new Date().toISOString()
  };
}

const current=JSON.parse(await fs.readFile(CURRENT,'utf8'));
let old={stations:{}};try{old=JSON.parse(await fs.readFile(OUT,'utf8'));old.stations ||= {}}catch{}
const rows=['queue','reservations','connected','withdrawn'].flatMap(k=>Array.isArray(current[k])?current[k]:[]);
const stations=[...new Set(rows.map(x=>x.station).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'nb'));
const cache={updated_at:null,source:'NVE Nettanlegg4 / Transformatorstasjoner',stations:{}};

for(const station of stations){
  console.log(`NVE-sjekk: ${station}`);
  try{
    const found=await locate(station);
    if(found){
      cache.stations[station]=found;
      console.log(`  -> ${found.display_name}: ${found.lat}, ${found.lon} (${found.confidence})`);
    }else{
      cache.stations[station]={station,base:cleanName(station),lat:null,lon:null,confidence:'unresolved',source:'NVE Nettanlegg4 / Transformatorstasjoner',checked_at:new Date().toISOString()};
      console.log('  -> ikke sikkert identifisert i NVE');
    }
  }catch(e){
    console.warn(`  -> NVE-oppslag feilet: ${e.message}`);
    cache.stations[station]={station,base:cleanName(station),lat:null,lon:null,confidence:'unresolved',source:'NVE Nettanlegg4 / Transformatorstasjoner',checked_at:new Date().toISOString(),error:e.message};
  }
  await sleep(150);
}
cache.updated_at=new Date().toISOString();
cache.station_count=stations.length;
cache.resolved_count=stations.filter(s=>validCoord(cache.stations[s])).length;
cache.unresolved_count=cache.station_count-cache.resolved_count;
await fs.mkdir('data',{recursive:true});
await fs.writeFile(OUT,JSON.stringify(cache,null,2)+'\n');
console.log(`Stasjoner: ${cache.resolved_count}/${cache.station_count} autoritativt koordinatfestet fra NVE.`);
