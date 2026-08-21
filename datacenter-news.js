// Latest Norwegian data center news panel, visually separated from the capacity section.
(function(){
  function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
  function fmtDate(v){try{return new Date(v).toLocaleDateString('nb-NO',{day:'2-digit',month:'short',year:'numeric'})}catch{return ''}}

  function ensurePanel(){
    let panel=document.getElementById('datacenterNewsPanel');
    if(panel) return panel;

    const mapCard=document.querySelector('.mapcard');
    if(!mapCard) return null;

    // Keep grid-capacity content and editorial/news content visually distinct.
    let row=document.getElementById('mapNewsRow');
    if(!row){
      row=document.createElement('section');
      row.id='mapNewsRow';
      row.className='map-news-row';
      mapCard.parentNode.insertBefore(row,mapCard);
      row.appendChild(mapCard);
    }

    panel=document.createElement('aside');
    panel.id='datacenterNewsPanel';
    panel.className='card panel news-panel';
    panel.innerHTML='<div class="news-kicker">DATASENTER · NYHETER</div><div class="news-head"><div><h2>Nyeste om datasenter i Norge</h2><div class="hint">Separat nyhetsstrøm – ikke en del av Statnetts kapasitetsdata.</div></div><div id="datacenterNewsStamp" class="hint"></div></div><div id="datacenterNewsList" class="news-list"><div class="hint">Henter artikler…</div></div>';
    row.appendChild(panel);

    const style=document.createElement('style');
    style.textContent=`
      .map-news-row{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(300px,.85fr);gap:14px;margin-top:14px;align-items:stretch}
      .map-news-row .mapcard{margin-top:0;min-width:0}
      .news-panel{margin:0;min-width:0;border-top:4px solid #0d1b15;background:#fbfcfb}
      .news-kicker{font-size:9px;font-weight:900;letter-spacing:.1em;color:var(--green);margin-bottom:7px}
      .news-head{display:block}
      .news-head h2{font-size:16px;margin:0 0 5px}
      #datacenterNewsStamp{margin-top:7px}
      .news-list{display:grid;gap:0;margin-top:12px}
      .news-item{display:block;text-decoration:none;color:inherit;padding:13px 2px;border-top:1px solid var(--line);transition:padding .14s ease,background .14s ease}
      .news-item:first-child{border-top:0}
      .news-item:hover{padding-left:7px;background:#f5f8f6}
      .news-source{font-size:9px;color:var(--green);font-weight:850;text-transform:uppercase;letter-spacing:.04em}
      .news-title{font-size:12px;font-weight:800;line-height:1.35;margin-top:5px}
      .news-date{font-size:9px;color:var(--muted);margin-top:6px}
      .news-more{font-size:10px;font-weight:800;color:var(--green);margin-top:6px}
      @media(max-width:1150px){.map-news-row{grid-template-columns:1fr}.news-panel{order:2}.news-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}}
      @media(max-width:650px){.news-list{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);

    // Leaflet needs a resize after its container width changes.
    setTimeout(()=>{try{if(window.map)window.map.invalidateSize(true);else if(typeof map!=='undefined'&&map)map.invalidateSize(true)}catch{}},250);
    return panel;
  }

  async function loadNews(){
    const panel=ensurePanel(); if(!panel) return;
    const list=document.getElementById('datacenterNewsList'),stamp=document.getElementById('datacenterNewsStamp');
    try{
      const r=await fetch('./data/datacenter-news.json?v='+Date.now(),{cache:'no-store'});
      if(!r.ok) throw new Error('Nyhetsdata kunne ikke lastes');
      const d=await r.json();
      const articles=Array.isArray(d.articles)?d.articles.slice(0,7):[];
      stamp.textContent=d.updated_at?'Oppdatert '+new Date(d.updated_at).toLocaleString('nb-NO',{dateStyle:'medium',timeStyle:'short'}):'';
      if(!articles.length){list.innerHTML='<div class="hint">Ingen relevante artikler funnet akkurat nå.</div>';return;}
      list.innerHTML=articles.map(a=>'<a class="news-item" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer"><div class="news-source">'+esc(a.source||'Kilde')+'</div><div class="news-title">'+esc(a.title)+'</div><div class="news-date">'+esc(fmtDate(a.published_at))+'</div><div class="news-more">Les artikkel ↗</div></a>').join('');
    }catch(e){console.error('datacenter news',e);list.innerHTML='<div class="hint">Nyhetsstrømmen er midlertidig utilgjengelig.</div>'}
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',loadNews); else loadNews();
  setInterval(loadNews,30*60*1000);
})();
