// Expand dashboard geography from NO1/NO5 to all Norwegian price areas.
(function(){
  function install(){
    const controls=document.querySelector('.controls');
    if(!controls)return;
    const all=controls.querySelector('[data-area="ALL"]');
    if(all)all.textContent='Hele Norge';
    for(const a of ['NO1','NO2','NO3','NO4','NO5']){
      if(controls.querySelector(`[data-area="${a}"]`))continue;
      const b=document.createElement('button');b.dataset.area=a;b.textContent=a;
      const search=controls.querySelector('#industry');controls.insertBefore(b,search||null);
      b.addEventListener('click',()=>{document.querySelectorAll('[data-area]').forEach(x=>x.classList.remove('active'));b.classList.add('active');try{area=a}catch{};if(typeof render==='function')render()});
    }
    const title=document.querySelector('.title');if(title)title.textContent='Nettkapasitet | Norge';
    const sub=document.querySelector('.sub');if(sub)sub.textContent='Kraftkrevende forbruk · NO1–NO5 · Statnett · automatisk oppdatering';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
