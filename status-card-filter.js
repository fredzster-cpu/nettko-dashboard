// Turn the four status KPI cards into the primary status filter.
// KPI values stay visible for every status card even when another status is selected.
(function(){
  const select=document.getElementById('statusFilter');
  if(!select) return;
  const grid=document.querySelector('section.grid');
  if(!grid) return;

  const statusCards=[...grid.querySelectorAll('.card.kpi')].slice(0,4);
  const statusNames=['Kapasitetskø','Reservert','Tilknyttet','Tilbaketrukket'];
  const statusConfig=[
    {status:'Kapasitetskø',key:'queue',mw:'qmw',cases:'qcases'},
    {status:'Reservert',key:'reservations',mw:'rmw',cases:'rcases'},
    {status:'Tilknyttet',key:'connected',mw:'cmw',cases:'ccases'},
    {status:'Tilbaketrukket',key:'withdrawn',mw:'wmw',cases:'wcases'}
  ];

  select.style.display='none';
  const reset=document.createElement('button');
  reset.type='button';reset.className='status-reset active';reset.textContent='Alle statuser';reset.title='Vis alle statuser';select.insertAdjacentElement('afterend',reset);

  function rowsIgnoringStatus(){
    const ind=document.getElementById('industry')?.value||'ALL';
    const q=(document.getElementById('search')?.value||'').trim().toLowerCase();
    return all().filter(p=>(area==='ALL'||p.area===area)&&(ind==='ALL'||p.industry===ind)&&(!q||[p.end_customer,p.grid_customer,p.station,p.area_plan,p.industry,p.statnett_case,p.tilko_case].filter(Boolean).join(' ').toLowerCase().includes(q)));
  }

  function exactStatnettDisplay(cfg){
    const ind=document.getElementById('industry')?.value||'ALL';
    const q=(document.getElementById('search')?.value||'').trim();
    // Exact Statnett KPI overrides are valid only before industry/search filtering.
    if(ind!=='ALL'||q) return null;
    const t=current?.statnett_display_totals?.[cfg.key];
    if(!t) return null;
    if(area==='NO1'||area==='NO5') return Number(t[area]);
    if(area==='ALL'&&Number.isFinite(Number(t.NO1))&&Number.isFinite(Number(t.NO5))) return Number(t.NO1)+Number(t.NO5);
    return null;
  }

  function refreshPersistentMetrics(){
    try{
      const base=rowsIgnoringStatus();
      for(const cfg of statusConfig){
        const rows=base.filter(p=>p.status===cfg.status);
        const rowMw=rows.reduce((s,p)=>s+(Number(p.mw)||0),0);
        const exact=exactStatnettDisplay(cfg);
        const mw=exact==null?rowMw:exact;
        const mwEl=document.getElementById(cfg.mw),casesEl=document.getElementById(cfg.cases);
        if(mwEl) mwEl.textContent=fmt(mw);
        if(casesEl) casesEl.textContent=rows.length+' saker';
      }
    }catch(e){console.error('status-card metrics',e)}
  }

  statusCards.forEach((card,i)=>{
    card.dataset.statusCard=statusNames[i];card.setAttribute('role','button');card.setAttribute('tabindex','0');card.setAttribute('aria-pressed','false');card.title='Filtrer på '+statusNames[i];
    const activate=()=>{select.value=statusNames[i];select.dispatchEvent(new Event('change',{bubbles:true}));sync();setTimeout(refreshPersistentMetrics,0)};
    card.addEventListener('click',activate);card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate()}});
  });

  reset.addEventListener('click',()=>{select.value='ALL';select.dispatchEvent(new Event('change',{bubbles:true}));sync();setTimeout(refreshPersistentMetrics,0)});
  function sync(){const value=select.value;reset.classList.toggle('active',value==='ALL');statusCards.forEach(card=>{const on=card.dataset.statusCard===value;card.classList.toggle('status-card-active',on);card.setAttribute('aria-pressed',String(on))})}

  const style=document.createElement('style');
  style.textContent=`.card.kpi[data-status-card]{cursor:pointer;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease;position:relative}.card.kpi[data-status-card]:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(20,50,35,.11);border-color:#abc6b8}.card.kpi[data-status-card]:focus-visible{outline:3px solid rgba(10,112,82,.24);outline-offset:2px}.card.kpi[data-status-card].status-card-active{border:2px solid var(--green);box-shadow:0 0 0 3px rgba(10,112,82,.08),0 12px 30px rgba(20,50,35,.10)}.card.kpi[data-status-card].status-card-active:after{content:'Valgt';position:absolute;top:10px;right:10px;background:#e3f3eb;color:#075f45;border-radius:999px;padding:3px 7px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}.controls .status-reset{font-weight:750;cursor:pointer}.controls .status-reset.active{background:#11221a;color:#fff}`;
  document.head.appendChild(style);

  select.addEventListener('change',()=>{sync();setTimeout(refreshPersistentMetrics,0)});
  document.getElementById('industry')?.addEventListener('change',()=>setTimeout(refreshPersistentMetrics,0));
  document.getElementById('search')?.addEventListener('input',()=>setTimeout(refreshPersistentMetrics,0));
  document.querySelectorAll('[data-area]').forEach(b=>b.addEventListener('click',()=>setTimeout(refreshPersistentMetrics,0)));
  sync();setTimeout(refreshPersistentMetrics,0);setInterval(refreshPersistentMetrics,5*60*1000);
})();
