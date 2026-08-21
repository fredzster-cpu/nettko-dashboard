// Add transformer stations for NO2/NO3/NO4 without disturbing the verified project-location layer.
(function(){
  const norm=s=>String(s||'').toLowerCase().replace(/transformatorstasjon/g,'').replace(/kra\s*\/\s*tra|tra\s*\/\s*kra|\btra\b|\bkra\b|\bse\b/g,'').replace(/[^a-z0-9æøå]+/g,' ').trim();
  const valid=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
  function findLoc(station){const dict=stationData?.stations||{};if(dict[station])return dict[station];const n=norm(station);for(const[k,v]of Object.entries(dict))if(norm(k)===n)return v;return null}
  function voltageText(loc){const levels=Array.isArray(loc?.voltage_levels_kv)?loc.voltage_levels_kv.filter(valid).map(Number):[];if(levels.length)return[...new Set(levels)].sort((a,b)=>b-a).join(' / ')+' kV';const v=loc?.voltage_kv;return valid(v)?Number(v)+' kV':'Spenningsnivå ikke tilgjengelig'}
  function install(){
    if(typeof renderMap!=='function'||typeof L==='undefined')return setTimeout(install,300);
    if(renderMap.__allAreasPatched)return;
    const base=renderMap;
    const wrapped=function(ps){
      const south=ps.filter(p=>p.area==='NO1'||p.area==='NO5');
      base(south);
      if(!map||!markerLayer)return;
      const north=ps.filter(p=>['NO2','NO3','NO4'].includes(p.area));
      const grouped={};for(const p of north){if(p.station)(grouped[p.station]??=[]).push(p)}
      const bounds=[];
      for(const[station,rows]of Object.entries(grouped)){
        const loc=findLoc(station);if(!loc||!valid(loc.lat)||!valid(loc.lon))continue;
        const lat=Number(loc.lat),lon=Number(loc.lon),mw=sum(rows),area0=rows[0]?.area||'';
        if(lat<57||lat>72||lon<2||lon>32)continue;
        const html='<div class="station-pin"><span class="station-dot"></span><span class="station-label">'+escapeHtml(station)+'</span><span class="station-mw">'+Math.round(mw).toLocaleString('nb-NO')+' MW</span></div>';
        const icon=L.divIcon({className:'station-div-icon',html,iconSize:[1,1],iconAnchor:[0,0]});
        const popup='<div class="popup-title">'+escapeHtml(station)+'</div><div><span class="popup-kpi">'+fmt(mw)+'</span> · '+rows.length+' saker</div><div class="station-meta"><b>Spenningsnivå:</b> '+escapeHtml(voltageText(loc))+'</div><div class="hint">'+escapeHtml(area0)+' · kilde NVE</div><ul class="popup-list">'+[...rows].sort((a,b)=>(b.mw||0)-(a.mw||0)).slice(0,12).map(p=>'<li><b>'+escapeHtml(p.end_customer||p.grid_customer||'–')+'</b> · '+fmt(p.mw)+' · '+escapeHtml(p.status||'')+'</li>').join('')+'</ul>';
        L.marker([lat,lon],{icon,zIndexOffset:1000}).bindPopup(popup,{maxWidth:380}).addTo(markerLayer);bounds.push([lat,lon]);
      }
      if(north.length&&bounds.length){const allBounds=[];markerLayer.eachLayer(l=>{if(typeof l.getLatLng==='function'){const x=l.getLatLng();allBounds.push([x.lat,x.lng])}});if(allBounds.length){map.fitBounds(allBounds,{padding:[45,45],maxZoom:7});setTimeout(()=>map.invalidateSize(true),100)}}
      if(north.length&&els?.mapStats){const shown=Object.keys(grouped).filter(s=>{const l=findLoc(s);return l&&valid(l.lat)&&valid(l.lon)}).length;els.mapStats.textContent=shown+' stasjoner vist i '+[...new Set(north.map(x=>x.area))].join(', ')}
    };
    wrapped.__allAreasPatched=true;renderMap=wrapped;
    if(typeof filtered==='function'&&map)renderMap(filtered());
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(install,900));else setTimeout(install,900);
})();
