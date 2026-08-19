import fs from 'node:fs/promises';

const CURRENT='data/current.json';
const OUT='data/stations.json';
const UA='nettko-dashboard/1.0 (public Statnett capacity dashboard; GitHub fredzster-cpu/nettko-dashboard)';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function cleanName(name=''){
  return name
    .replace(/\s+(KRA\s*\/\s*TRA|TRA\s*\/\s*KRA)\s*$/i,'')
    .replace(/\s+(TRA|KRA|SE)\s*$/i,'')
    .trim();
}
function validCoord(x){return Number.isFinite(Number(x?.lat))&&Number.isFinite(Number(x?.lon));}
function scoreResult(r,base){
  const text=`${r.display_name||''} ${r.type||''} ${r.category||''}`.toLowerCase();
  let s=0;
  if(text.includes(base.toLowerCase())) s+=5;
  if(text.includes('substation')||text.includes('transformator')||text.includes('kraftstasjon')) s+=8;
  if(r.type==='substation') s+=10;
  if(String(r.display_name||'').toLowerCase().includes('norway')||String(r.display_name||'').toLowerCase().includes('norge')) s+=2;
  return s;
}
async function nominatim(q){
  const u=new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('format','jsonv2');u.searchParams.set('limit','5');u.searchParams.set('countrycodes','no');u.searchParams.set('q',q);
  const res=await fetch(u,{headers:{'User-Agent':UA,'Accept-Language':'nb,no,en'}});
  if(!res.ok) throw new Error(`Nominatim ${res.status}`);
  return res.json();
}
async function locate(station){
  const base=cleanName(station);
  const queries=[`${base} transformatorstasjon, Norge`,`${base} kraftstasjon, Norge`,`${base}, Norge`];
  let best=null;
  for(const q of queries){
    try{
      const results=await nominatim(q);
      for(const r of results){
        const cand={lat:Number(r.lat),lon:Number(r.lon),display_name:r.display_name||'',osm_type:r.osm_type||'',osm_id:r.osm_id||null,score:scoreResult(r,base)};
        if(validCoord(cand)&&(!best||cand.score>best.score)) best=cand;
      }
    }catch(e){console.warn(`Geokoding feilet for ${station}: ${e.message}`)}
    if(best?.score>=10) break;
    await sleep(1100);
  }
  if(!best) return null;
  return {station,base,lat:best.lat,lon:best.lon,display_name:best.display_name,confidence:best.score>=10?'high':best.score>=6?'medium':'low',source:'OpenStreetMap/Nominatim',checked_at:new Date().toISOString()};
}

const current=JSON.parse(await fs.readFile(CURRENT,'utf8'));
let cache={updated_at:null,source:'OpenStreetMap/Nominatim',stations:{}};
try{cache=JSON.parse(await fs.readFile(OUT,'utf8'));cache.stations ||= {}}catch{}
const rows=['queue','reservations','connected','withdrawn'].flatMap(k=>Array.isArray(current[k])?current[k]:[]);
const stations=[...new Set(rows.map(x=>x.station).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'nb'));
let changed=false;
for(const station of stations){
  if(validCoord(cache.stations[station])) continue;
  console.log(`Geokoder: ${station}`);
  const found=await locate(station);
  if(found){cache.stations[station]=found;changed=true;console.log(`  -> ${found.lat}, ${found.lon} (${found.confidence})`)}
  else {cache.stations[station]={station,base:cleanName(station),lat:null,lon:null,confidence:'unresolved',source:'OpenStreetMap/Nominatim',checked_at:new Date().toISOString()};changed=true;console.log('  -> ikke funnet')}
  await sleep(1100);
}
cache.updated_at=new Date().toISOString();
cache.station_count=stations.length;
cache.resolved_count=stations.filter(s=>validCoord(cache.stations[s])).length;
await fs.mkdir('data',{recursive:true});
await fs.writeFile(OUT,JSON.stringify(cache,null,2)+'\n');
console.log(`Stasjoner: ${cache.resolved_count}/${cache.station_count} koordinatfestet${changed?' (cache oppdatert)':''}.`);
