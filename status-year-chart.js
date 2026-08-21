// Self-contained Statnett-style waterfall chart beside the map.
(function(){
  const mapCard=document.querySelector('.mapcard');
  if(!mapCard || typeof Chart==='undefined') return;
  if(document.querySelector('.map-status-layout')) return;

  const shell=document.createElement('section');
  shell.className='map-status-layout';
  mapCard.parentNode.insertBefore(shell,mapCard);

  const chartCard=document.createElement('div');
  chartCard.className='card panel status-year-card';
  chartCard.innerHTML=`
    <div class="status-year-total-label">Forbruk (MW)</div>
    <div class="status-year-total" id="statusYearTotal">Laster…</div>
    <div class="status-year-title" id="statusYearTitle">Alle statuser – forbruk (MW)</div>
    <div class="status-year-hint" id="statusYearHint">Laster årsfordeling…</div>
    <div class="status-year-canvas"><canvas id="statusYearChart"></canvas></div>`;

  shell.appendChild(chartCard);
  shell.appendChild(mapCard);

  let data=null;
  let yearlyChart=null;
  const statusSelect=document.getElementById('statusFilter');
  const industry=document.getElementById('industry');
  const search=document.getElementById('search');

  function activeArea(){return document.querySelector('[data-area].active')?.dataset.area || 'ALL';}
  function allRows(){return data?['queue','reservations','connected','withdrawn'].flatMap(k=>Array.isArray(data[k])?data[k]:[]):[];}
  function parseYear(s){const m=String(s||'').match(/(20\d{2})/);return m?Number(m[1]):null;}
  function filteredRows(){
    const a=activeArea(),ind=industry?.value||'ALL',st=statusSelect?.value||'ALL',q=(search?.value||'').trim().toLowerCase();
    return allRows().filter(p=>(a==='ALL'||p.area===a)&&(ind==='ALL'||p.industry===ind)&&(st==='ALL'||p.status===st)&&(!q||[p.end_customer,p.grid_customer,p.station,p.area_plan,p.industry,p.statnett_case,p.tilko_case].filter(Boolean).join(' ').toLowerCase().includes(q)));
  }
  function activeLabel(){const st=statusSelect?.value||'ALL';return st==='ALL'?'Alle statuser':st;}

  function render(){
    if(!data) return;
    const rows=filteredRows();
    const byYear=new Map();
    for(const r of rows){const y=parseYear(r.date);if(!y)continue;byYear.set(y,(byYear.get(y)||0)+(Number(r.mw)||0));}
    const years=[...byYear.keys()].sort((a,b)=>a-b);
    const increments=years.map(y=>Math.round(byYear.get(y)||0));
    const total=rows.reduce((s,r)=>s+(Number(r.mw)||0),0);

    const totalEl=document.getElementById('statusYearTotal'),titleEl=document.getElementById('statusYearTitle'),hintEl=document.getElementById('statusYearHint');
    if(totalEl) totalEl.textContent=Math.round(total).toLocaleString('nb-NO');
    if(titleEl) titleEl.textContent=activeLabel()+' – forbruk (MW)';
    if(hintEl) hintEl.textContent=rows.length+' saker i aktivt utvalg · waterfall: hver søyle starter der forrige år sluttet.';

    if(yearlyChart){yearlyChart.destroy();yearlyChart=null;}
    const canvas=document.getElementById('statusYearChart');if(!canvas)return;
    if(!years.length){const c=canvas.getContext('2d');c.clearRect(0,0,canvas.width,canvas.height);if(hintEl)hintEl.textContent='Ingen daterte saker i aktivt utvalg.';return;}

    let running=0;
    const bases=increments.map(v=>{const b=running;running+=v;return b;});
    const tops=bases.map((b,i)=>b+increments[i]);

    const connectorPlugin={id:'waterfallConnectors',afterDatasetsDraw(chart){const meta=chart.getDatasetMeta(1);if(!meta?.data?.length)return;const {ctx}=chart;ctx.save();ctx.strokeStyle='rgba(11,75,58,.45)';ctx.lineWidth=1;for(let i=0;i<meta.data.length-1;i++){const a=meta.data[i],b=meta.data[i+1],y=chart.scales.y.getPixelForValue(tops[i]);ctx.beginPath();ctx.moveTo(a.x+a.width/2,y);ctx.lineTo(b.x-b.width/2,y);ctx.stroke();}ctx.restore();}};
    const labelPlugin={id:'waterfallLabels',afterDatasetsDraw(chart){const meta=chart.getDatasetMeta(1),{ctx}=chart;ctx.save();ctx.fillStyle='#17382e';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.font='12px Inter, system-ui, sans-serif';meta.data.forEach((bar,i)=>{const y=chart.scales.y.getPixelForValue(tops[i]);ctx.fillText(increments[i].toLocaleString('nb-NO'),bar.x,y-7);});ctx.restore();}};

    yearlyChart=new Chart(canvas,{type:'bar',data:{labels:years,datasets:[{label:'Startnivå',data:bases,backgroundColor:'rgba(0,0,0,0)',borderWidth:0,stack:'waterfall',barPercentage:.72,categoryPercentage:.82},{label:'Årlig endring',data:increments,backgroundColor:'#0b4b3a',borderColor:'#0b4b3a',borderWidth:0,borderRadius:0,stack:'waterfall',maxBarThickness:68,barPercentage:.72,categoryPercentage:.82}]},options:{responsive:true,maintainAspectRatio:false,animation:false,layout:{padding:{top:26,right:4,bottom:0,left:0}},plugins:{legend:{display:false},tooltip:{filter:item=>item.datasetIndex===1,callbacks:{label:c=>increments[c.dataIndex].toLocaleString('nb-NO')+' MW'}}},scales:{x:{stacked:true,grid:{display:false},border:{display:false},ticks:{color:'#18362c'}},y:{stacked:true,beginAtZero:true,border:{display:false},grid:{color:'rgba(70,95,85,.18)',borderDash:[2,5]},ticks:{color:'#18362c',callback:v=>Number(v).toLocaleString('nb-NO')}}}},plugins:[connectorPlugin,labelPlugin]});
  }

  async function refreshData(){try{const r=await fetch('./data/current.json?v='+Date.now(),{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);data=await r.json();render();}catch(e){console.error('status-year-chart data load',e);const t=document.getElementById('statusYearTotal'),h=document.getElementById('statusYearHint');if(t)t.textContent='–';if(h)h.textContent='Kunne ikke laste data for grafen.';}}

  const style=document.createElement('style');
  style.textContent=`.map-status-layout{display:grid;grid-template-columns:minmax(300px,.7fr) minmax(0,1.3fr);gap:14px;margin-top:14px;align-items:stretch}.map-status-layout .mapcard{margin-top:0;min-width:0}.map-status-layout .mapwrap{height:560px}.status-year-card{min-width:0;display:flex;flex-direction:column}.status-year-total-label{text-align:center;font-size:16px;margin-top:3px;color:#17211c}.status-year-total{text-align:center;font-size:31px;line-height:1.1;color:#06392d;margin:5px 0 18px}.status-year-title{font-size:17px;color:#0c4034;margin-bottom:4px}.status-year-hint{font-size:10px;color:var(--muted);line-height:1.35;min-height:28px}.status-year-canvas{height:430px;margin-top:6px}@media(max-width:1050px){.map-status-layout{grid-template-columns:1fr}.map-status-layout .mapwrap{height:500px}.status-year-canvas{height:320px}}`;
  document.head.appendChild(style);

  [statusSelect,industry].filter(Boolean).forEach(el=>el.addEventListener('change',()=>setTimeout(render,0)));search?.addEventListener('input',()=>setTimeout(render,0));document.querySelectorAll('[data-area]').forEach(b=>b.addEventListener('click',()=>setTimeout(render,0)));document.querySelector('section.grid')?.addEventListener('click',e=>{if(e.target.closest('[data-status-card]'))setTimeout(render,20);});refreshData();setInterval(refreshData,5*60*1000);
})();
