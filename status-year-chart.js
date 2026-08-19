// Add a Power BI-inspired yearly MW chart beside the map and reduce map to half width.
(function(){
  const mapCard=document.querySelector('.mapcard');
  if(!mapCard || typeof Chart==='undefined') return;

  const shell=document.createElement('section');
  shell.className='map-status-layout';
  mapCard.parentNode.insertBefore(shell,mapCard);

  const chartCard=document.createElement('div');
  chartCard.className='card panel status-year-card';
  chartCard.innerHTML=`
    <div class="status-year-total-label">Forbruk (MW)</div>
    <div class="status-year-total" id="statusYearTotal">–</div>
    <div class="status-year-title" id="statusYearTitle">Forbruk (MW)</div>
    <div class="status-year-hint" id="statusYearHint">Årlig MW basert på datoen som er publisert for sakene i aktivt utvalg.</div>
    <div class="status-year-canvas"><canvas id="statusYearChart"></canvas></div>`;

  shell.appendChild(chartCard);
  shell.appendChild(mapCard);

  let yearlyChart=null;
  const statusSelect=document.getElementById('statusFilter');
  const industry=document.getElementById('industry');
  const search=document.getElementById('search');

  function parseYear(s){
    const m=String(s||'').match(/(20\d{2})/);
    return m?Number(m[1]):null;
  }

  function baseRows(){
    if(typeof all!=='function') return [];
    const ind=industry?.value||'ALL';
    const q=(search?.value||'').trim().toLowerCase();
    const st=statusSelect?.value||'ALL';
    return all().filter(p=>(area==='ALL'||p.area===area)
      &&(ind==='ALL'||p.industry===ind)
      &&(st==='ALL'||p.status===st)
      &&(!q||[p.end_customer,p.grid_customer,p.station,p.area_plan,p.industry,p.statnett_case,p.tilko_case]
        .filter(Boolean).join(' ').toLowerCase().includes(q)));
  }

  function activeLabel(){
    const st=statusSelect?.value||'ALL';
    return st==='ALL'?'Alle statuser':st;
  }

  function renderYearChart(){
    // `current` is declared with top-level `let` in index.html and therefore is not
    // exposed as window.current. Use all() as the readiness check instead.
    if(typeof all!=='function') return;
    const rows=baseRows();
    const byYear=new Map();
    for(const r of rows){
      const y=parseYear(r.date);
      if(!y) continue;
      byYear.set(y,(byYear.get(y)||0)+(Number(r.mw)||0));
    }
    const years=[...byYear.keys()].sort((a,b)=>a-b);
    const vals=years.map(y=>Math.round(byYear.get(y)||0));
    const total=rows.reduce((s,r)=>s+(Number(r.mw)||0),0);
    const totalEl=document.getElementById('statusYearTotal');
    const titleEl=document.getElementById('statusYearTitle');
    const hintEl=document.getElementById('statusYearHint');
    if(totalEl) totalEl.textContent=Math.round(total).toLocaleString('nb-NO');
    if(titleEl) titleEl.textContent=activeLabel()+' – forbruk (MW)';
    if(hintEl) hintEl.textContent=rows.length
      ? `${rows.length} saker i aktivt utvalg · fordelt etter publisert dato/statusdato.`
      : 'Ingen saker i aktivt utvalg.';

    if(yearlyChart) yearlyChart.destroy();
    const ctx=document.getElementById('statusYearChart');
    if(!ctx || !years.length) return;
    yearlyChart=new Chart(ctx,{
      type:'bar',
      data:{labels:years,datasets:[{data:vals,borderWidth:0,borderRadius:0,maxBarThickness:90,backgroundColor:'#0b4b3a'}]},
      options:{
        responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>Number(c.raw).toLocaleString('nb-NO')+' MW'}}},
        scales:{
          x:{grid:{display:false},ticks:{color:'#18362c'}},
          y:{beginAtZero:true,grid:{color:'rgba(70,95,85,.18)',borderDash:[2,5]},ticks:{color:'#18362c',callback:v=>Number(v).toLocaleString('nb-NO')}}
        }
      },
      plugins:[{
        id:'valuesAboveBars',
        afterDatasetsDraw(chart){
          const {ctx}=chart;ctx.save();ctx.fillStyle='#17382e';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.font='12px Inter, system-ui, sans-serif';
          chart.getDatasetMeta(0).data.forEach((bar,i)=>ctx.fillText(vals[i].toLocaleString('nb-NO'),bar.x,bar.y-7));ctx.restore();
        }
      }]
    });
    setTimeout(()=>{if(typeof map!=='undefined'&&map) map.invalidateSize(true)},80);
  }

  const style=document.createElement('style');
  style.textContent=`
    .map-status-layout{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:stretch}
    .map-status-layout .mapcard{margin-top:0;min-width:0}
    .map-status-layout .mapwrap{height:520px}
    .status-year-card{min-width:0;display:flex;flex-direction:column}
    .status-year-total-label{text-align:center;font-size:18px;margin-top:5px;color:#17211c}
    .status-year-total{text-align:center;font-size:36px;line-height:1.1;color:#06392d;margin:7px 0 26px}
    .status-year-title{font-size:20px;color:#0c4034;margin-bottom:5px}
    .status-year-hint{font-size:11px;color:var(--muted);line-height:1.4;min-height:31px}
    .status-year-canvas{height:390px;margin-top:8px}
    @media(max-width:1050px){.map-status-layout{grid-template-columns:1fr}.map-status-layout .mapwrap{height:460px}.status-year-canvas{height:330px}}
  `;
  document.head.appendChild(style);

  [statusSelect,industry].filter(Boolean).forEach(el=>el.addEventListener('change',()=>setTimeout(renderYearChart,0)));
  search?.addEventListener('input',()=>setTimeout(renderYearChart,0));
  document.querySelectorAll('[data-area]').forEach(b=>b.addEventListener('click',()=>setTimeout(renderYearChart,0)));
  // Status cards are added by another sidecar script; delegate clicks so this works regardless of load order.
  document.addEventListener('click',e=>{if(e.target.closest?.('[data-status-card]')) setTimeout(renderYearChart,20)});
  setTimeout(renderYearChart,250);
  setInterval(renderYearChart,5*60*1000);
})();
