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

// Latest changes: compare the latest validated dataset with the previous daily snapshot.
(function(){
  const kpiGrid=document.querySelector('section.grid');
  if(!kpiGrid) return;

  const statusOrder={'Kapasitetskø':0,'Reservert':1,'Tilknyttet':2,'Tilbaketrukket':3};
  const statusKeys=['queue','reservations','connected','withdrawn'];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateFmt=s=>{try{return new Date(s+'T12:00:00').toLocaleDateString('nb-NO',{day:'numeric',month:'short'})}catch{return s}};

  const panel=document.createElement('section');
  panel.className='card panel latest-changes-card';
  panel.innerHTML=`<div class="latest-head"><div><h2>Siste endringer</h2><div class="hint" id="latestChangesHint">Sammenligner siste validerte Statnett-data med forrige snapshot.</div></div><div class="latest-summary" id="latestChangesSummary">Laster…</div></div><div id="latestChangesList" class="latest-list"></div>`;
  kpiGrid.insertAdjacentElement('afterend',panel);

  const style=document.createElement('style');
  style.textContent=`.latest-changes-card{margin-top:14px;padding:17px}.latest-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.latest-head h2{font-size:15px;margin:0 0 4px}.latest-summary{font-size:11px;color:var(--muted);text-align:right;white-space:nowrap}.latest-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}.latest-item{border:1px solid var(--line);border-radius:11px;padding:10px 12px;display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:start;background:#fbfcfb}.latest-icon{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:900}.latest-icon.good{background:#e1f2ea;color:#075f45}.latest-icon.warn{background:#fff1d5;color:#8b5c0f}.latest-icon.bad{background:#f8e8e5;color:#81483f}.latest-icon.info{background:#e4f0f8;color:#245b82}.latest-title{font-size:12px;font-weight:800;line-height:1.3}.latest-meta{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.35}.latest-mw{font-size:11px;font-weight:800;white-space:nowrap}.latest-empty{font-size:12px;color:var(--muted);padding:8px 0}@media(max-width:850px){.latest-list{grid-template-columns:1fr}.latest-head{display:block}.latest-summary{text-align:left;margin-top:5px}}`;
  document.head.appendChild(style);

  function rows(d){
    return statusKeys.flatMap(k=>(Array.isArray(d?.[k])?d[k]:[]).map(x=>({...x,_set:k})));
  }
  function key(r){
    const c=String(r.statnett_case||'').trim();
    if(c) return 'S:'+c;
    const t=String(r.tilko_case||'').trim();
    if(t) return 'T:'+t;
    return 'F:'+[(r.end_customer||r.grid_customer||''),(r.station||''),Number(r.mw)||0].join('|').toLowerCase();
  }
  function mapRows(d){
    const m=new Map();
    for(const r of rows(d)){
      const k=key(r); const old=m.get(k);
      // If a case appears in more than one list, keep the furthest progressed status.
      if(!old||((statusOrder[r.status]??-1)>(statusOrder[old.status]??-1))) m.set(k,r);
    }
    return m;
  }
  function areaOk(r){return typeof area==='undefined'||area==='ALL'||r.area===area}
  function industryOk(r){const v=document.getElementById('industry')?.value||'ALL';return v==='ALL'||r.industry===v}
  function searchOk(r){const q=(document.getElementById('search')?.value||'').trim().toLowerCase();if(!q)return true;return [r.end_customer,r.grid_customer,r.station,r.area_plan,r.industry,r.statnett_case,r.tilko_case].filter(Boolean).join(' ').toLowerCase().includes(q)}
  function filterChange(c){const r=c.current||c.previous;return r&&areaOk(r)&&industryOk(r)&&searchOk(r)}

  function classify(prev,cur){
    if(prev&&cur&&prev.status!==cur.status){
      if(prev.status==='Kapasitetskø'&&cur.status==='Reservert') return {kind:'good',icon:'✓',label:'Fra kø → Reservert'};
      if(cur.status==='Tilknyttet') return {kind:'good',icon:'✓',label:(prev.status==='Kapasitetskø'?'Fra kø → Tilknyttet':'Tilknyttet')};
      if(cur.status==='Tilbaketrukket') return {kind:'bad',icon:'↘',label:'Tilbaketrukket'};
      if(prev.status==='Kapasitetskø') return {kind:'info',icon:'→',label:'Ut av kapasitetskø'};
      return {kind:'info',icon:'→',label:prev.status+' → '+cur.status};
    }
    if(!prev&&cur) return {kind:'info',icon:'+',label:'Ny sak i '+cur.status.toLowerCase()};
    if(prev&&!cur) return {kind:'warn',icon:'−',label:prev.status==='Kapasitetskø'?'Ut av kapasitetskø':'Ut av publisert oversikt'};
    if(prev&&cur&&Math.abs((Number(prev.mw)||0)-(Number(cur.mw)||0))>0.01) return {kind:'warn',icon:'±',label:'Kapasitet endret'};
    return null;
  }

  function diff(previousData,currentData){
    const p=mapRows(previousData),c=mapRows(currentData),out=[];
    for(const k of new Set([...p.keys(),...c.keys()])){
      const previous=p.get(k)||null,current=c.get(k)||null,cls=classify(previous,current);
      if(!cls) continue;
      out.push({previous,current,...cls});
    }
    const priority={'Fra kø → Reservert':0,'Tilknyttet':1,'Fra kø → Tilknyttet':1,'Tilbaketrukket':2,'Ut av kapasitetskø':3,'Kapasitet endret':4};
    return out.sort((a,b)=>(priority[a.label]??5)-(priority[b.label]??5)||Math.abs(Number(b.current?.mw??b.previous?.mw)||0)-Math.abs(Number(a.current?.mw??a.previous?.mw)||0));
  }

  let allChanges=[],priorDate=null,currentDate=null;
  function renderChanges(){
    const list=document.getElementById('latestChangesList'),sumEl=document.getElementById('latestChangesSummary'),hint=document.getElementById('latestChangesHint');
    if(!list) return;
    const visible=allChanges.filter(filterChange);
    const transitions=visible.filter(x=>x.previous&&x.current&&x.previous.status!==x.current.status).length;
    const added=visible.filter(x=>!x.previous&&x.current).length;
    const removed=visible.filter(x=>x.previous&&!x.current).length;
    sumEl.textContent=`${visible.length} endringer · ${transitions} statusbytter · ${added} nye · ${removed} ut`;
    hint.textContent=priorDate?`Endringer siden ${dateFmt(priorDate)}. Basert på validerte Statnett-snapshots.`:'Sammenligner siste validerte Statnett-data med forrige snapshot.';
    if(!visible.length){list.innerHTML='<div class="latest-empty">Ingen endringer i valgt utvalg siden forrige snapshot.</div>';return}
    list.innerHTML=visible.slice(0,8).map(c=>{
      const r=c.current||c.previous; const name=r.end_customer||r.grid_customer||'Ukjent kunde';
      const oldMw=Number(c.previous?.mw)||0,newMw=Number(c.current?.mw)||0;
      const mwText=c.previous&&c.current&&Math.abs(oldMw-newMw)>.01?`${Math.round(oldMw).toLocaleString('nb-NO')} → ${Math.round(newMw).toLocaleString('nb-NO')} MW`:`${Math.round(Number(r.mw)||0).toLocaleString('nb-NO')} MW`;
      const meta=[r.area,r.station,r.statnett_case].filter(Boolean).join(' · ');
      return `<div class="latest-item"><div class="latest-icon ${c.kind}">${c.icon}</div><div><div class="latest-title">${esc(c.label)} · ${esc(name)}</div><div class="latest-meta">${esc(meta)}</div></div><div class="latest-mw">${esc(mwText)}</div></div>`;
    }).join('');
  }

  async function loadPrevious(){
    try{
      // Wait until the main dashboard has loaded current.json.
      for(let i=0;i<80&&(!current||!current.updated_at);i++) await new Promise(r=>setTimeout(r,100));
      if(!current?.updated_at) throw new Error('current.json er ikke lastet ennå');
      currentDate=String(current.updated_at).slice(0,10);
      const base=new Date(currentDate+'T12:00:00');
      let previousData=null;
      for(let back=1;back<=10;back++){
        const d=new Date(base);d.setDate(d.getDate()-back);const iso=d.toISOString().slice(0,10);
        const res=await fetch(`./data/snapshots/${iso}.json?v=${Date.now()}`,{cache:'no-store'}).catch(()=>null);
        if(res?.ok){previousData=await res.json();priorDate=iso;break}
      }
      if(!previousData) throw new Error('fant ikke et tidligere snapshot');
      allChanges=diff(previousData,current);renderChanges();
    }catch(e){
      const list=document.getElementById('latestChangesList'),sumEl=document.getElementById('latestChangesSummary');
      if(sumEl) sumEl.textContent='Ikke tilgjengelig';
      if(list) list.innerHTML='<div class="latest-empty">Kan ikke beregne siste endringer ennå: '+esc(e.message)+'</div>';
      console.warn('latest changes',e);
    }
  }

  document.getElementById('industry')?.addEventListener('change',renderChanges);
  document.getElementById('search')?.addEventListener('input',renderChanges);
  document.querySelectorAll('[data-area]').forEach(b=>b.addEventListener('click',()=>setTimeout(renderChanges,0)));
  loadPrevious();
})();
