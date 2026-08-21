// Robust station markers for the Nettkapasitet dashboard.
(function(){
  const norm=s=>String(s||'').toLowerCase().replace(/transformatorstasjon/g,'').replace(/kra\s*\/\s*tra|tra\s*\/\s*kra|\btra\b|\bkra\b|\bse\b/g,'').replace(/[^a-z0-9æøå]+/g,' ').trim();
  const valid=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
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
  function voltageText(loc){
    const levels=Array.isArray(loc?.voltage_levels_kv)?loc.voltage_levels_kv.filter(valid).map(Number):[];
    if(levels.length) return [...new Set(levels)].sort((a,b)=>b-a).join(' / ')+' kV';
    const raw=loc?.voltage_kv;
    if(raw===null||raw===undefined||raw==='') return 'Spenningsnivå ikke tilgjengelig';
    if(Array.isArray(raw)) return raw.filter(valid).map(Number).sort((a,b)=>b-a).join(' / ')+' kV';
    const s=String(raw).trim();
    return s ? s.replace(/\s*kV$/i,'')+' kV' : 'Spenningsnivå ikke tilgjengelig';
  }
  renderMap=function(ps){
    if(!map||typeof L==='undefined') return;
    if(markerLayer) markerLayer.clearLayers(); else markerLayer=L.layerGroup().addTo(map);
    const grouped={};
    for(const p of ps){ if(!p.station) continue; (grouped[p.station]??=[]).push(p); }
    const bounds=[]; let shown=0,missing=0,rejected=0;
    for(const [station,rows] of Object.entries(grouped)){
      const loc=findLoc(station);
      if(!loc||!valid(loc.lat)||!valid(loc.lon)){missing++;continue;}
      const lat=Number(loc.lat),lon=Number(loc.lon),area0=rows[0]?.area||'';
      if(!plausible(area0,lat,lon)){rejected++;continue;}
      const mw=sum(rows);
      const icon=L.divIcon({
        className:'station-div-icon',
        html:markerHtml(station,mw,loc.confidence),
        iconSize:[1,1],iconAnchor:[0,0]
      });
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
      bounds.push([lat,lon]); shown++;
    }
    els.mapStats.textContent=shown+' stasjoner vist'+(missing?' · '+missing+' uten koordinat':'')+(rejected?' · '+rejected+' holdt tilbake pga. usikker plassering':'');
    if(bounds.length){ map.fitBounds(bounds,{padding:[55,55],maxZoom:8}); mapHasFit=true; setTimeout(()=>map.invalidateSize(true),100); }
  };
  const css=document.createElement('style');
  css.textContent='.station-div-icon{background:transparent!important;border:0!important}.station-pin{position:relative;transform:translate(-8px,-8px);white-space:nowrap;font:700 11px Inter,system-ui,sans-serif;color:#123b2d}.station-dot{display:inline-block;width:16px;height:16px;border-radius:50%;background:#0a7052;border:3px solid #fff;box-shadow:0 1px 7px rgba(0,0,0,.35);vertical-align:middle}.station-pin.low .station-dot{background:#ad7417}.station-label{display:inline-block;margin-left:5px;padding:3px 6px;background:rgba(255,255,255,.94);border:1px solid #dce7e1;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.12);vertical-align:middle}.station-mw{display:inline-block;margin-left:3px;padding:3px 5px;background:#123b2d;color:#fff;border-radius:6px;vertical-align:middle;font-size:10px}.station-meta{margin-top:5px;font-size:12px;color:#263b31}';
  document.head.appendChild(css);
  function apply(){ try{ if(typeof filtered==='function'&&typeof renderMap==='function'&&map) renderMap(filtered()); }catch(e){ console.error('map-fix',e); } }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(apply,700)); else setTimeout(apply,700);
  setInterval(apply,5*60*1000);
})();
