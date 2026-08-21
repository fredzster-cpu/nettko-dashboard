import fs from 'node:fs/promises';

const OUT='data/datacenter-news.json';
const query='(datasenter OR "data center") Norge';
const rss='https://news.google.com/rss/search?q='+encodeURIComponent(query)+'&hl=no&gl=NO&ceid=NO:no';

function decode(s=''){
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n)))
    .trim();
}
function stripTags(s=''){return decode(s.replace(/<[^>]+>/g,' ').replace(/\s+/g,' '));}
function tag(block,name){const m=block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'));return m?decode(m[1]):'';}
function source(block){const m=block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);return m?stripTags(m[1]):'';}
function directDescription(block){
  const raw=tag(block,'description');
  return stripTags(raw).replace(/^.*? - /,'').slice(0,280);
}

const r=await fetch(rss,{headers:{'user-agent':'Mozilla/5.0 NettkoDashboard/1.0','accept':'application/rss+xml,application/xml,text/xml'}});
if(!r.ok) throw new Error(`Google News RSS ${r.status}`);
const xml=await r.text();
const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m=>m[1]);
const now=Date.now();
const maxAge=45*24*60*60*1000;
const seen=new Set();
const articles=[];
for(const item of items){
  let title=stripTags(tag(item,'title'));
  const url=stripTags(tag(item,'link'));
  const publishedRaw=stripTags(tag(item,'pubDate'));
  const published=new Date(publishedRaw);
  const src=source(item) || (title.includes(' - ')?title.split(' - ').pop():'');
  if(src && title.endsWith(' - '+src)) title=title.slice(0,-(' - '+src).length);
  if(!title||!url||Number.isNaN(published.getTime())) continue;
  if(now-published.getTime()>maxAge) continue;
  const hay=(title+' '+directDescription(item)).toLowerCase();
  if(!/(datasenter|data center|datacenter|ki-senter|ai-senter)/i.test(hay)) continue;
  if(seen.has(title.toLowerCase())) continue;
  seen.add(title.toLowerCase());
  articles.push({title,url,source:src||'Ukjent kilde',published_at:published.toISOString(),summary:directDescription(item)});
  if(articles.length>=12) break;
}
if(articles.length<3) throw new Error(`For få relevante artikler funnet: ${articles.length}`);
await fs.mkdir('data',{recursive:true});
await fs.writeFile(OUT,JSON.stringify({updated_at:new Date().toISOString(),query,articles},null,2)+'\n');
console.log(`Lagret ${articles.length} datasenterartikler til ${OUT}`);
