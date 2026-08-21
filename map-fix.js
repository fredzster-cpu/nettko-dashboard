// Robust station markers + verified data-center project locations.
(function(){
  const norm=s=>String(s||'').toLowerCase().replace(/transformatorstasjon/g,'').replace(/kra\s*\/\s*tra|tra\s*\/\s*kra|\btra\b|\bkra\b|\bse\b/g,'').replace(/[^a-z0-9æøå]+/g,' ').trim();
  const valid=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
  let projectData={projects:[]},projectLayer=null,connectionLayer=null,mapLayerControl=null;
  let showStations=true,showProjects=true;

  function findLoc(station){
    const dict=stationData?.stations||{};
    if(dict[station]) return dict[station];
    const n=norm(station);
    for(const [k,v] of Object.entries(dict)) if(norm(k)===n) return v;
    return null;
  }
  function plausible(area,lat,lon){
    if(lat<57.5||lat>64.0||lon<3.5||lon>13.5) return false;
    if(area==='NO1' && (lat>62.4||lon<7.0||lon>12.8)) return false;
    if(area==='NO5' && (lat<58.8||lat>62.6||lon<3.8||lon>9.2)) return false;
    return true;
  }
  function markerHtml(name,mw,confidence){
    const cls=confidence==='low'?' low':'';
    return '<div class="station-pin'+cls+'"><span class="station-dot"></span><span class="station-label">'+escapeHtml(name)+'</span><span class="station-mw">'+Math.round(mw).toLocaleString('nb-NO')+' MW</span></div>';
  }
  function projectHtml(p){
    const cls=p.confidence==='confirmed'?' confirmed':' probable';
    return '<div class="project-pin'+cls+'"><span class="project-dot"></span><span class="project-label">'+escapeHtml(p.customer)+'</span><span class="project-mw">'+Math.round(Number(p.mw)||0).toLocaleString('nb-NO')+' MW</span></div>';
  }
  function voltageText(loc){
    const levels=Array.isArray(loc?.voltage_levels_kv)?loc.voltage_levels_kv.filter(valid).map(Number):[];
    if(levels.length) return [...new Set(levels)].sort((a,b)=>b-a).join(' / ')+' kV';
    const raw=loc?.voltage_kv;
    if(raw===null||raw===undefined||raw==='') return 'Spenningsnivå ikke tilgjengelig';
    if(Array.isArray(raw)) return raw.filter(valid).map(Number).sort((a,b)=>b-a).join(' / ')+' kV';
    const s=String(raw).trim();
    return s ? s.replace(/\s*kV$/i,'')+' kV' : 'Spenningsnivå ikke tilgjengelig';
  }
  function currentCaseMap(ps){
    const m=new Map();
    for(const p of ps){
      const k=String(p.statnett_case||'').trim();
      if(k) m.set(k,p);
    }
    return m;
  }
  function sourceLinks(p){
    const src=Array.isArray(p.sources)?p.sources:[];
    if(!src.length)return '';
    return '<div class="project-sources"><b>Kilder:</b> '+src.map(s=>'<a href="'+escapeHtml(s.url)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(s.label||'Kilde')+' ↗</a>').join(' · ')+'</div>';
  }
  function ensureLayerControl(){
    if(mapLayerControl||!map||typeof L==='undefined')return;
    const C=L.Control.extend({
      options:{position:'topleft'},
      onAdd(){
        const el=L.DomUtil.create('div','map-layer-control leaflet-bar');
        el.innerHTML='<div class="layer-title">Kartlag</div><label><input id="toggleStations" type="checkbox" checked> <span class="legend-station"></span>Trafostasjoner</label><label><input id="toggleProjects" type="checkbox" checked> <span class="legend-project"></span>Datasenterlokasjoner</label><div class="layer-hint">Stiplet linje = nettilknytning</div>';
        L.DomEvent.disableClickPropagation(el);L.DomEvent.disableScrollPropagation(el);
        setTimeout(()=>{
          el.querySelector('#toggleStations')?.addEventListener('change',e=>{showStations=e.target.checked;apply()});
          el.querySelector('#toggleProjects')?.addEventListener('change',e=>{showProjects=e.target.checked;apply()});
        },0);
        return el;
      }
    });
    mapLayerControl=new C().addTo(map);
  }
  function renderProjects(ps,bounds){
    if(!map)return;
    if(projectLayer)projectLayer.clearLayers();else projectLayer=L.layerGroup().addTo(map);
    if(connectionLayer)connectionLayer.clearLayers();else connectionLayer=L.layerGroup().addTo(map);
    if(!showProjects)return 0;
    const cases=currentCaseMap(ps);let shown=0;
    for(const p of (projectData.projects||[])){
      const live=cases.get(String(p.statnett_case||'').trim());
      if(!live||!valid(p.lat)||!valid(p.lon))continue;
      const lat=Number(p.lat),lon=Number(p.lon);
      const icon=L.divIcon({className:'project-div-icon',html:projectHtml(p),iconSize:[1,1],iconAnchor:[0,0]});
      const conf=p.confidence_label||p.confidence||'Ukjent';
      const popup='<div class="popup-title">'+escapeHtml(p.customer)+'</div>'+
        '<div><span class="popup-kpi">'+fmt(live.mw||p.mw)+'</span> · '+escapeHtml(live.status||'')+'</div>'+
        '<div class="project-confidence '+(p.confidence==='confirmed'?'ok':'maybe')+'">Lokasjon: '+escapeHtml(conf)+'</div>'+
        '<div class="station-meta"><b>Prosjektsted:</b> '+escapeHtml(p.location_name||p.address||'–')+'</div>'+
        (p.address?'<div class="hint">'+escapeHtml(p.address)+'</div>':'')+
        '<div class="station-meta"><b>Tilknytningspunkt:</b> '+escapeHtml(live.station||p.station||'–')+'</div>'+
        '<div class="station-meta"><b>Statnett-sak:</b> '+escapeHtml(p.statnett_case||'–')+'</div>'+
        (p.note?'<div class="project-note">'+escapeHtml(p.note)+'</div>':'')+sourceLinks(p);
      L.marker([lat,lon],{icon,zIndexOffset:2200}).bindPopup(popup,{maxWidth:420}).addTo(projectLayer);
      const sloc=findLoc(live.station||p.station);
      if(sloc&&valid(sloc.lat)&&valid(sloc.lon)){
        L.polyline([[lat,lon],[Number(sloc.lat),Number(sloc.lon)]],{weight:2,opacity:.58,dashArray:'6 6',color:'#6b46c1',interactive:false}).addTo(connectionLayer);
      }
      bounds.push([lat,lon]);shown++;
    }
    return shown;
  }

  renderMap=function(ps){
    if(!map||typeof L==='undefined') return;
    ensureLayerControl();
    if(markerLayer) markerLayer.clearLayers(); else markerLayer=L.layerGroup().addTo(map);
    const grouped={};for(const p of ps){if(!p.station)continue;(grouped[p.station]??=[]).push(p)}
    const bounds=[];let shown=0,missing=0,rejected=0;
    if(showStations){
      for(const [station,rows] of Object.entries(grouped)){
        const loc=findLoc(station);
        if(!loc||!valid(loc.lat)||!valid(loc.lon)){missing++;continue;}
        const lat=Number(loc.lat),lon=Number(loc.lon),area0=rows[0]?.area||'';
        if(!plausible(area0,lat,lon)){rejected++;continue;}
        const mw=sum(rows);
        const icon=L.divIcon({className:'station-div-icon',html:markerHtml(station,mw,loc.confidence),iconSize:[1,1],iconAnchor:[0,0]});
        const vtext=voltageText(loc);
        const popup='<div class="popup-title">'+escapeHtml(station)+'</div>'+
          '<div><span class="popup-kpi">'+fmt(mw)+'</span> · '+rows.length+' saker</div>'+
          '<div class="station-meta"><b>Spenningsnivå:</b> '+escapeHtml(vtext)+'</div>'+
          (loc.owner?'<div class="station-meta"><b>Eier:</b> '+escapeHtml(loc.owner)+'</div>':'')+
          (loc.voltage_source?'<div class="hint">Spenningskilde: '+escapeHtml(loc.voltage_source)+'</div>':'')+
          '<div class="hint">'+escapeHtml(area0)+' · posisjon '+escapeHtml(loc.confidence||'ukjent')+' · kilde NVE</div>'+
          '<ul class="popup-list">'+[...rows].sort((a,b)=>(b.mw||0)-(a.mw||0)).slice(0,12).map(p=>'<li><b>'+escapeHtml(p.end_customer||p.grid_customer||'–')+'</b> · '+fmt(p.mw)+' · '+escapeHtml(p.status||'')+'</li>').join('')+'</ul>'+
          (rows.length>12?'<div class="hint">+'+(rows.length-12)+' flere saker</div>':'');
        L.marker([lat,lon],{icon,zIndexOffset:1000}).bindPopup(popup,{maxWidth:380}).addTo(markerLayer);
        bounds.push([lat,lon]);shown++;
      }
    }
    const projectShown=renderProjects(ps,bounds);
    els.mapStats.textContent=shown+' stasjoner'+(projectShown?' · '+projectShown+' prosjektlokasjoner':'')+(missing?' · '+missing+' uten koordinat':'')+(rejected?' · '+rejected+' holdt tilbake':'');
    if(bounds.length){map.fitBounds(bounds,{padding:[55,55],maxZoom:8});mapHasFit=true;setTimeout(()=>map.invalidateSize(true),100)}
  };

  const css=document.createElement('style');
  css.textContent='.station-div-icon,.project-div-icon{background:transparent!important;border:0!important}.station-pin,.project-pin{position:relative;transform:translate(-8px,-8px);white-space:nowrap;font:700 11px Inter,system-ui,sans-serif}.station-dot,.project-dot{display:inline-block;width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 7px rgba(0,0,0,.35);vertical-align:middle}.station-dot{background:#0a7052}.station-pin.low .station-dot{background:#ad7417}.project-dot{background:#6b46c1;width:18px;height:18px}.project-pin.probable .project-dot{background:#8b6fc4}.station-label,.project-label{display:inline-block;margin-left:5px;padding:3px 6px;background:rgba(255,255,255,.95);border:1px solid #dce7e1;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12);vertical-align:middle;color:#123b2d}.project-label{border-color:#d9cff1;color:#432c7a}.station-mw,.project-mw{display:inline-block;margin-left:3px;padding:3px 5px;color:#fff;border-radius:6px;vertical-align:middle;font-size:10px}.station-mw{background:#123b2d}.project-mw{background:#5b3ca6}.station-meta{margin-top:5px;font-size:12px;color:#263b31}.project-confidence{display:inline-block;margin-top:7px;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:800}.project-confidence.ok{background:#e2f3ea;color:#075f45}.project-confidence.maybe{background:#f1ecfb;color:#5b3ca6}.project-note{margin-top:8px;padding:8px;background:#f7f5fb;border-radius:8px;font-size:11px;line-height:1.4}.project-sources{margin-top:8px;font-size:10px;line-height:1.5}.project-sources a{color:#5b3ca6;text-decoration:none}.map-layer-control{background:rgba(255,255,255,.96);padding:9px 10px!important;border-radius:9px!important;border:1px solid #dfe7e2!important;box-shadow:0 2px 12px rgba(0,0,0,.12)!important;min-width:165px;font:11px Inter,system-ui,sans-serif;color:#20352b}.map-layer-control label{display:block;margin:6px 0;cursor:pointer}.layer-title{font-weight:800;margin-bottom:5px}.layer-hint{font-size:9px;color:#6d7b73;margin-top:5px}.legend-station,.legend-project{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 5px 0 3px}.legend-station{background:#0a7052}.legend-project{background:#6b46c1}';
  document.head.appendChild(css);

  async function loadProjects(){
    try{
      const r=await fetch('./data/datacenter-locations.json?v='+Date.now(),{cache:'no-store'});
      if(r.ok)projectData=await r.json();
    }catch(e){console.warn('project locations',e)}
    apply();
  }
  function apply(){try{if(typeof filtered==='function'&&typeof renderMap==='function'&&map)renderMap(filtered())}catch(e){console.error('map-fix',e)}}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{setTimeout(apply,700);setTimeout(loadProjects,850)});else{setTimeout(apply,700);setTimeout(loadProjects,850)}
  setInterval(apply,5*60*1000);
})();
