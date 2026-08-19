// Table enhancements: sortable columns + sticky totals footer
(function(){
  let sortKey='mw', sortDir='desc';
  const cols=['end_customer','status','area','mw','industry','station','area_plan','grid_customer','statnett_case','date'];
  const labels=['Sluttkunde','Status','NO','MW','Næring','Stasjon','Områdeplan','Nettselskap','Statnett sak','Dato'];
  function val(p,k){
    if(k==='mw') return Number(p.mw)||0;
    if(k==='date'){
      const m=String(p.date||'').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      return m?new Date(+m[3],+m[2]-1,+m[1]).getTime():0;
    }
    return String(p[k]??'').toLocaleLowerCase('nb');
  }
  function sorted(ps){return [...ps].sort((a,b)=>{const av=val(a,sortKey),bv=val(b,sortKey);let c=typeof av==='number'?av-bv:av.localeCompare(bv,'nb',{numeric:true});return sortDir==='asc'?c:-c})}
  function installHead(){
    const tr=document.querySelector('#projects thead tr'); if(!tr)return;
    tr.innerHTML=labels.map((l,i)=>'<th data-sort="'+cols[i]+'" style="cursor:pointer;user-select:none" title="Klikk for å sortere">'+l+' <span class="sortmark"></span></th>').join('');
    tr.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.sort;sortDir=(sortKey===k&&sortDir==='desc')?'asc':'desc';sortKey=k;render()}));
    updateMarks();
  }
  function updateMarks(){document.querySelectorAll('#projects th[data-sort]').forEach(th=>{const s=th.querySelector('.sortmark');if(s)s.textContent=th.dataset.sort===sortKey?(sortDir==='asc'?'▲':'▼'):''})}
  window.renderTable=function(ps){
    updateMarks();
    const rows=sorted(ps), total=rows.reduce((s,p)=>s+(Number(p.mw)||0),0);
    els.countHint.textContent=rows.length+' saker i utvalget · '+fmt(total)+' totalt';
    els.tbody.innerHTML=rows.map(p=>'<tr><td><b>'+escapeHtml(p.end_customer||p.grid_customer||'–')+'</b></td><td><span class="status s-'+escapeHtml(p.status)+'">'+escapeHtml(p.status)+'</span></td><td>'+escapeHtml(p.area||'–')+'</td><td><b>'+escapeHtml(p.mw??'–')+'</b></td><td>'+escapeHtml(p.industry||'–')+'</td><td>'+escapeHtml(p.station||'–')+'</td><td>'+escapeHtml(p.area_plan||'–')+'</td><td>'+escapeHtml(p.grid_customer||'–')+'</td><td>'+escapeHtml(p.statnett_case||'–')+'</td><td>'+escapeHtml(p.date||'–')+'</td></tr>').join('')+'<tr class="total-row"><td><b>SUM</b></td><td><b>'+rows.length+' saker</b></td><td></td><td><b>'+Math.round(total).toLocaleString('nb-NO')+'</b></td><td colspan="6"></td></tr>';
  };
  const style=document.createElement('style');style.textContent='.sortmark{font-size:9px;margin-left:4px;color:#0a7052}.total-row td{position:sticky;bottom:0;background:#edf5f1!important;border-top:2px solid #bfd3c9;font-weight:800;z-index:3}.total-row td:first-child{color:#0a7052}';document.head.appendChild(style);
  installHead();
  if(typeof render==='function')render();
})();
