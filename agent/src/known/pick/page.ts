/** The single self-contained picker page: no framework, no external requests. Names are inserted with textContent only. */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Known gallery picker</title>
<style>
:root{--bg:#fafafa;--fg:#1a1a1a;--muted:#666;--card:#fff;--line:#d5d5d5;--pick:#16a34a;--sug:#d97706;--warn:#dc2626;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#9a9a9a;--card:#1e1e1e;--line:#3a3a3a;--pick:#4ade80;--sug:#fbbf24;--warn:#f87171;--accent:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
h1{font-size:18px;margin:0}.aliases,.meta{color:var(--muted);font-size:13px}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,.box:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
#msg{padding:8px 16px;min-height:1.2em}.bad{color:var(--warn)}.ok{color:var(--pick)}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;padding:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}
.wrap{position:relative;line-height:0}.wrap img{width:100%;height:auto;border-radius:4px}
.box{position:absolute;box-sizing:border-box;border:2px solid #fff;box-shadow:0 0 0 1px #000;background:transparent;padding:0;border-radius:3px;cursor:pointer}
.box span{position:absolute;top:-1px;left:-1px;background:#000;color:#fff;font:bold 12px system-ui;line-height:1;padding:2px 5px;border-radius:2px}
.box.pick{border-color:var(--pick);border-width:4px;background:rgba(22,163,74,.2)}
.box.sug{border-color:var(--sug);border-style:dashed;border-width:3px}
.box.low{border-color:var(--warn);border-width:4px}
figcaption{font-size:12px;color:var(--muted);padding-top:6px;word-break:break-word;line-height:1.3}
</style></head><body>
<header>
<div><h1 id="name">Loading...</h1><div class="aliases" id="aliases"></div></div>
<div class="meta" id="progress"></div>
<div id="count" role="status"></div>
<button id="save" class="primary" disabled>Save (Enter)</button>
<button id="skip">Skip (S)</button>
<button id="done">Done (D)</button>
</header>
<div id="msg" role="status"></div>
<div id="grid"></div>
<script>
(function(){
var token=new URLSearchParams(location.search).get('token')||'';
var $=function(i){return document.getElementById(i)};
var queue=[],cur=null,data=null,picks=[],sug=[],warn=[],MIN=3,MAX=10,timer=null;
function api(path,method,body){
  return fetch('/api'+path,{method:method||'GET',headers:{'X-Pick-Token':token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})
    .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})});
}
function say(t,cls){var m=$('msg');m.textContent=t||'';m.className=cls||''}
function key(p,f){return p+':'+f}
function has(p,f){return picks.some(function(x){return x.photo===p&&x.face===f})}
function isIn(list,p,f){return list.some(function(x){return x.photo===p&&x.face===f})}
function nextPending(){return queue.find(function(p){return p.state==='pending'})}
function load(){
  var p=nextPending();
  if(!p){cur=null;$('name').textContent='All done';$('aliases').textContent='';$('grid').textContent='';$('count').textContent='';$('save').disabled=true;say('No more people. Press Done to finish.','ok');progress();return}
  cur=p;$('name').textContent=p.name+' ('+p.id+')';$('aliases').textContent=p.aliases.length?'Also: '+p.aliases.join(', '):'';
  progress();poll();
}
function progress(){var d=queue.filter(function(p){return p.state!=='pending'}).length;$('progress').textContent=d+' of '+queue.length+' handled'}
function poll(){
  clearTimeout(timer);say('Fetching photos and detecting faces (this can take a minute)...');$('grid').textContent='';$('save').disabled=true;
  var id=cur.id;
  api('/person/'+id).then(function(d){
    if(!cur||cur.id!==id)return;
    if(d.status==='loading'){timer=setTimeout(poll,2000);return}
    if(d.status==='error'){say('Failed: '+d.message+' (press R to retry)','bad');return}
    data=d;picks=d.preselected.slice();sug=d.suggestions;warn=d.warnings;say(d.photos.length?'':'No usable photos found. Skip this person.',d.photos.length?'':'bad');render();
  }).catch(function(e){say(e.message,'bad')});
}
function render(){
  var g=$('grid');g.textContent='';
  data.photos.forEach(function(ph,pi){
    var fig=document.createElement('figure'),wrap=document.createElement('div');wrap.className='wrap';
    var img=document.createElement('img');img.alt=ph.title;img.loading='lazy';img.src='/api/person/'+cur.id+'/image/'+pi+'?token='+encodeURIComponent(token);wrap.appendChild(img);
    ph.faces.forEach(function(f,fi){
      var b=document.createElement('button');b.className='box';b.type='button';
      var on=has(pi,fi);if(on)b.className+=' pick';else if(isIn(sug,pi,fi))b.className+=' sug';
      if(on&&isIn(warn,pi,fi))b.className+=' low';
      b.style.left=(f.bbox[0]/ph.width*100)+'%';b.style.top=(f.bbox[1]/ph.height*100)+'%';
      b.style.width=((f.bbox[2]-f.bbox[0])/ph.width*100)+'%';b.style.height=((f.bbox[3]-f.bbox[1])/ph.height*100)+'%';
      var n=document.createElement('span');n.textContent=String(fi+1);b.appendChild(n);
      b.setAttribute('aria-pressed',on?'true':'false');b.setAttribute('aria-label','Photo '+(pi+1)+' face '+(fi+1));
      b.onclick=function(){toggle(pi,fi)};wrap.appendChild(b);
    });
    var cap=document.createElement('figcaption');cap.textContent=ph.title.replace(/^File:/,'')+' | '+ph.license;
    fig.appendChild(wrap);fig.appendChild(cap);g.appendChild(fig);
  });
  status();
}
function status(){
  var n=picks.length,ok=n>=MIN;
  $('count').textContent=n+' picked (minimum '+MIN+', at most '+MAX+' are used)';
  $('save').disabled=!ok;
  if(!ok)say('Pick at least '+MIN+' faces to save (you have '+n+'), or skip.','bad');
  else if(warn.length)say('Warning: '+warn.length+' picked face(s) look unlike the others (cosine below 0.3, red boxes). Check them.','bad');
  else say(n>MAX?'Only the first '+MAX+' picks are used.':'');
}
function toggle(p,f){
  var i=picks.findIndex(function(x){return x.photo===p&&x.face===f});
  if(i>=0)picks.splice(i,1);else picks.push({photo:p,face:f});
  var id=cur.id;
  api('/person/'+id+'/suggest','POST',{picks:picks}).then(function(d){if(cur&&cur.id===id){sug=d.suggestions;warn=d.warnings;render()}}).catch(function(e){say(e.message,'bad')});
  render();
}
function save(){
  if(!cur||picks.length<MIN)return;
  api('/person/'+cur.id+'/save','POST',{picks:picks}).then(function(){cur.state='saved';load()}).catch(function(e){say(e.message,'bad')});
}
function skip(){if(!cur)return;api('/person/'+cur.id+'/skip','POST').then(function(){cur.state='skipped';load()}).catch(function(e){say(e.message,'bad')})}
function finish(){api('/done','POST').then(function(){document.body.textContent='Done. You can close this tab.'}).catch(function(e){say(e.message,'bad')})}
$('save').onclick=save;$('skip').onclick=skip;$('done').onclick=finish;
document.addEventListener('keydown',function(e){
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key==='Enter'&&document.activeElement&&document.activeElement.className.indexOf('box')>=0)return;
  if(e.key==='Enter')save();else if(e.key==='s'||e.key==='S')skip();else if(e.key==='d'||e.key==='D')finish();
  else if((e.key==='r'||e.key==='R')&&cur)api('/person/'+cur.id+'/retry','POST').then(poll);
});
api('/queue').then(function(q){queue=q.people;MIN=q.min;MAX=q.max;load()}).catch(function(e){say(e.message,'bad')});
})();
</script></body></html>`;
