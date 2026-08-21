// Latest Norwegian data center news panel.
(function(){
  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  function fmtDate(v){try{return new Date(v).toLocaleDateString('nb-NO',{day:'2-digit',month:'short',year:'numeric'})}catch{return ''}}
  function ensurePanel(){
    if(document.getElementById('datacenterNewsPanel')) return document.getElementById('datacenterNewsPanel');
    const tabs=document.querySelector('.tabs');
    if(!tabs) return null;
    const section=document.createElement('section');
    section.id='datacenterNewsPanel';
    section.className='card panel';
    section.style.marginTop='14px';
    section.innerHTML='<div class="news-head"><div><h2>Nyeste om datasenter i Norge</h2><div class="hint">Automatisk oppdatert nyhetsstrøm. Klikk for å lese originalartikkelen.</div></div><div id="datacenterNewsStamp" class="hint"></div></div><div id="datacenterNewsList" class="news-grid"><div class="hint">Henter artikler…</div></div>';
    tabs.insertAdjacentElement('beforebegin',section);
    const style=document.createElement('style');
    style.textContent='.news-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.news-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}.news-item{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);border-radius:12px;padding:13px;background:#fff;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}.news-item:hover{transform:translateY(-2px);border-color:#b8ccc1;box-shadow:0 10px 25px rgba(25,45,35,.07)}.news-source{font-size:10px;color:var(--green);font-weight:800;text-transform:uppercase;letter-spacing:.04em}.news-title{font-size:13px;font-weight:800;line-height:1.35;margin-top:6px}.news-date{font-size:10px;color:var(--muted);margin-top:8px}.news-more{font-size:11px;font-weight:800;color:var(--green);margin-top:9px}@media(max-width:1050px){.news-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){.news-grid{grid-template-columns:1fr}.news-head{display:block}}';
    document.head.appendChild(style);
    return section;
  }
  async function loadNews(){
    const panel=ensurePanel(); if(!panel) return;
    const list=document.getElementById('datacenterNewsList'),stamp=document.getElementById('datacenterNewsStamp');
    try{
      const r=await fetch('./data/datacenter-news.json?v='+Date.now(),{cache:'no-store'});
      if(!r.ok) throw new Error('Nyhetsdata kunne ikke lastes');
      const d=await r.json();
      const articles=Array.isArray(d.articles)?d.articles.slice(0,6):[];
      stamp.textContent=d.updated_at?'Oppdatert '+new Date(d.updated_at).toLocaleString('nb-NO',{dateStyle:'medium',timeStyle:'short'}):'';
      if(!articles.length){list.innerHTML='<div class="hint">Ingen relevante artikler funnet akkurat nå.</div>';return;}
      list.innerHTML=articles.map(a=>'<a class="news-item" href="'+esc(a.url)+'" target="_blank" rel="noopener noreferrer"><div class="news-source">'+esc(a.source||'Kilde')+'</div><div class="news-title">'+esc(a.title)+'</div><div class="news-date">'+esc(fmtDate(a.published_at))+'</div><div class="news-more">Les artikkel ↗</div></a>').join('');
    }catch(e){console.error('datacenter news',e);list.innerHTML='<div class="hint">Nyhetsstrømmen er midlertidig utilgjengelig.</div>'}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',loadNews); else loadNews();
  setInterval(loadNews,30*60*1000);
})();
