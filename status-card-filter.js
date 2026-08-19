// Turn the four status KPI cards into the primary status filter.
(function(){
  const select=document.getElementById('statusFilter');
  if(!select) return;
  const controls=select.closest('.controls');
  const grid=document.querySelector('section.grid');
  if(!grid) return;

  const statusCards=[...grid.querySelectorAll('.card.kpi')].slice(0,4);
  const statusNames=['Kapasitetskø','Reservert','Tilknyttet','Tilbaketrukket'];

  // Replace dropdown with a simple reset button; filtering happens on KPI cards.
  select.style.display='none';
  const reset=document.createElement('button');
  reset.type='button';
  reset.className='status-reset active';
  reset.textContent='Alle statuser';
  reset.title='Vis alle statuser';
  select.insertAdjacentElement('afterend',reset);

  statusCards.forEach((card,i)=>{
    card.dataset.statusCard=statusNames[i];
    card.setAttribute('role','button');
    card.setAttribute('tabindex','0');
    card.setAttribute('aria-pressed','false');
    card.title='Filtrer på '+statusNames[i];
    const activate=()=>{
      select.value=statusNames[i];
      select.dispatchEvent(new Event('change',{bubbles:true}));
      sync();
    };
    card.addEventListener('click',activate);
    card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();}});
  });

  reset.addEventListener('click',()=>{
    select.value='ALL';
    select.dispatchEvent(new Event('change',{bubbles:true}));
    sync();
  });

  function sync(){
    const value=select.value;
    reset.classList.toggle('active',value==='ALL');
    statusCards.forEach(card=>{
      const on=card.dataset.statusCard===value;
      card.classList.toggle('status-card-active',on);
      card.setAttribute('aria-pressed',String(on));
    });
  }

  const style=document.createElement('style');
  style.textContent=`
    .card.kpi[data-status-card]{cursor:pointer;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease;position:relative}
    .card.kpi[data-status-card]:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(20,50,35,.11);border-color:#abc6b8}
    .card.kpi[data-status-card]:focus-visible{outline:3px solid rgba(10,112,82,.24);outline-offset:2px}
    .card.kpi[data-status-card].status-card-active{border:2px solid var(--green);box-shadow:0 0 0 3px rgba(10,112,82,.08),0 12px 30px rgba(20,50,35,.10)}
    .card.kpi[data-status-card].status-card-active:after{content:'Valgt';position:absolute;top:10px;right:10px;background:#e3f3eb;color:#075f45;border-radius:999px;padding:3px 7px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
    .controls .status-reset{font-weight:750;cursor:pointer}
    .controls .status-reset.active{background:#11221a;color:#fff}
  `;
  document.head.appendChild(style);
  select.addEventListener('change',sync);
  sync();
})();
