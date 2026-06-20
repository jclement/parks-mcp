// "Camp, Eh?" — campground availability map. Pins colored by jurisdiction, shaped by
// type. With dates set, the whole map lights up from the server-harvested availability
// cache (green = open, red = full, orange = stale data); "hide unavailable" filters to
// open ones. Pin popups show a colored mini-month + details. First visit shows a quick
// welcome; an About panel reports sources + refresh status.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0f14">
<title>Camp, Eh?</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="64x64">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Camp, Eh?">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  :root{--bg:#0b0f14;--panel:rgba(13,20,32,.94);--line:#1f2a3a;--ink:#e8eef5;--muted:#8aa0b8;--accent:#7c3aed;}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #map{position:absolute;inset:0}
  .bar{position:absolute;z-index:1000;top:10px;left:10px;right:10px;display:flex;gap:10px;
    align-items:center;justify-content:space-between;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:9px;background:var(--panel);border:1px solid var(--line);
    border-radius:13px;padding:7px 12px 7px 9px;backdrop-filter:blur(6px);box-shadow:0 8px 30px #0007}
  .brand img{width:26px;height:26px;display:block}
  .brand b{font-size:16px;letter-spacing:-.01em}
  .brand .sub{color:var(--muted);font-size:11px;margin-left:2px}
  .brand .info{cursor:pointer;color:var(--muted);border:1px solid var(--line);border-radius:50%;
    width:18px;height:18px;font-size:12px;line-height:16px;text-align:center;margin-left:4px}
  .ctl{display:flex;gap:9px;align-items:flex-end;background:var(--panel);border:1px solid var(--line);
    border-radius:13px;padding:8px 12px;backdrop-filter:blur(6px);box-shadow:0 8px 30px #0007}
  .ctl label{font-size:10.5px;color:var(--muted);display:flex;flex-direction:column;gap:3px;text-transform:uppercase;letter-spacing:.04em}
  .ctl input[type=date],.ctl input[type=number]{background:var(--bg);color:var(--ink);border:1px solid #2a3a4f;
    border-radius:8px;padding:6px 8px;font-size:14px;font-family:inherit}
  .ctl input#nights{width:54px}
  .ctl .hideb{display:flex;align-items:center;gap:6px;color:var(--ink);font-size:12px;cursor:pointer;padding-bottom:6px;text-transform:none;letter-spacing:0}
  .ctl .hideb input{width:16px;height:16px;accent-color:#22c55e}
  .ctl .info{cursor:pointer;color:var(--muted);border:1px solid var(--line);border-radius:50%;width:26px;height:26px;
    font-size:14px;line-height:24px;text-align:center;margin-bottom:2px;flex:none}
  .ctl .info:hover{color:var(--ink);border-color:#3a4d66}
  .legend{position:absolute;z-index:1000;bottom:10px;left:12px;right:88px;text-align:center;
    background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 18px;backdrop-filter:blur(6px)}
  .legend .keys{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-around;align-items:center;font-size:12.5px;color:#cbd5e1}
  .legend .keys span{display:flex;align-items:center;gap:5px;white-space:nowrap}
  .dot{width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 1.5px #0b0f14}
  .dia{width:10px;height:10px;transform:rotate(45deg);box-shadow:0 0 0 1.5px #0b0f14}
  .ring{width:10px;height:10px;border-radius:50%;background:#64748b}
  .ring.g{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #16a34a}.ring.r{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #dc2626}
  .ring.o{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #f59e0b}
  .mhint{position:absolute;z-index:1000;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(13,20,32,.9);
    border:1px solid var(--line);color:var(--muted);font-size:11.5px;padding:4px 11px;border-radius:9px;display:none;white-space:nowrap}
  @media (max-width:560px){
    .legend{display:none}
    .brand{display:none}
    .bar{top:8px;left:8px;right:8px;gap:8px;justify-content:flex-end}
    .mhint:not(:empty){display:block}
  }
  .keyrow{display:flex;flex-wrap:wrap;gap:9px 14px;font-size:12.5px;color:#cbd5e1;margin:8px 0 14px}
  .keyrow span{display:flex;align-items:center;gap:5px}
  /* modal */
  .modal{position:fixed;inset:0;z-index:2000;background:#0008;display:none;align-items:center;justify-content:center;padding:18px}
  .modal.on{display:flex}
  .card{background:#0e1622;border:1px solid var(--line);border-radius:18px;max-width:420px;width:100%;
    padding:22px;box-shadow:0 30px 80px #000a;max-height:86vh;overflow:auto}
  .card h2{margin:0 0 4px;font-size:21px;display:flex;align-items:center;gap:10px}
  .card h2 img{width:30px;height:30px}
  .card p{color:#cbd5e1;font-size:14px;line-height:1.55}
  .card ul{color:#cbd5e1;font-size:13.5px;line-height:1.6;padding-left:18px;margin:10px 0}
  .card .src{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:7px 0;font-size:13px}
  .card .src .age{color:var(--muted)}
  .card button{cursor:pointer;background:var(--accent);color:#fff;border:0;border-radius:10px;font-weight:600;
    font-size:14px;padding:9px 16px;margin-top:10px}
  .card a{color:#a78bfa;cursor:pointer}
  /* popup */
  .leaflet-popup-content{margin:11px 13px;font-size:13px;line-height:1.45;min-width:236px}
  .leaflet-popup-content b{font-size:14px}
  .leaflet-popup-content .tag{display:inline-block;font-size:11px;color:#8aa0b8;margin-top:2px}
  .leaflet-popup-content a.book{display:block;margin-top:9px;color:#7c3aed;font-weight:600}
  .leaflet-popup-content .ll{display:flex;align-items:center;gap:8px;margin:8px 0 0;width:fit-content;
    font-family:ui-monospace,monospace;font-size:12px;color:#334155;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:4px 5px 4px 9px}
  .leaflet-popup-content .ll button{cursor:pointer;background:#e2e8f0;color:#334155;border:0;border-radius:6px;font-size:11px;font-weight:600;padding:3px 9px}
  .leaflet-popup-content .desc{color:#334155;margin-top:8px;max-height:120px;overflow:auto}
  .leaflet-popup-content .muted{color:#94a3b8}
  .cal{margin-top:10px}
  .cal .mlabel{font-size:11px;color:#64748b;margin-bottom:4px;display:flex;justify-content:space-between}
  .cal .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
  .cal .wd{font-size:9px;color:#94a3b8;text-align:center}
  .cal .d{aspect-ratio:1;border-radius:4px;font-size:10px;display:flex;align-items:center;justify-content:center;color:#1e293b;background:#e5e7eb}
  .cal .d.g{background:#86efac}.cal .d.r{background:#fecaca}.cal .d.none{background:#f1f5f9;color:#cbd5e1}
  .leaflet-container{background:#0b0f14}
</style>
</head>
<body>
<div id="map"></div>
<div class="bar">
  <div class="brand">
    <img src="/favicon.svg" alt="">
    <div class="meta"><b>Camp, Eh?</b> <span class="sub" id="sub">loading…</span></div>
  </div>
  <div class="ctl">
    <label>Arrive<input type="date" id="start"></label>
    <label>Nights<input type="number" id="nights" min="1" max="14" value="2"></label>
    <label class="hideb"><input type="checkbox" id="hideUnavail">Open only</label>
    <div class="info" id="aboutBtn" title="About &amp; legend">?</div>
  </div>
</div>
<div class="legend"><div class="keys">
  <span><i class="dot" style="background:#f59e0b"></i>AB</span>
  <span><i class="dot" style="background:#38bdf8"></i>SK</span>
  <span><i class="dot" style="background:#22c55e"></i>BC</span>
  <span><i class="dot" style="background:#ef4444"></i>PC</span>
  <span><i class="dot" style="background:#cbd5e1"></i>front·<i class="dia" style="background:#cbd5e1"></i>back</span>
  <span><i class="ring g"></i>open <i class="ring r"></i>full <i class="ring o"></i>stale</span>
</div></div>
<div class="mhint" id="mhint"></div>

<div class="modal" id="welcome"><div class="card">
  <h2><img src="/favicon.svg" alt="">Camp, Eh?</h2>
  <p>Campsite availability across <b>Alberta Parks</b>, <b>BC Parks</b>, and <b>Parks Canada</b> — including backcountry and trails like the West Coast Trail — on one map.</p>
  <ul>
    <li>Pick an <b>arrive date + nights</b> up top.</li>
    <li>The map <b>lights up</b>: green = open, red = full, orange = a bit stale.</li>
    <li>Tick <b>Open only</b> to hide the full ones.</li>
    <li>Tap a pin for a <b>colored month view</b> + booking link.</li>
  </ul>
  <button id="welcomeOk">Let's go</button> <a id="welcomeAbout" style="margin-left:8px">how it works</a>
</div></div>

<div class="modal" id="about"><div class="card">
  <h2><img src="/favicon.svg" alt="">About Camp, Eh?</h2>
  <p>A read-only mirror of campground reservation systems, refreshed on a schedule so lookups are instant. Availability can lag the official sites — always confirm before you book.</p>
  <div class="keyrow">
    <span><i class="dot" style="background:#f59e0b"></i>Alberta</span>
    <span><i class="dot" style="background:#22c55e"></i>BC</span>
    <span><i class="dot" style="background:#ef4444"></i>Parks Canada</span>
    <span><i class="dot" style="background:#38bdf8"></i>Saskatchewan</span>
    <span><i class="dia" style="background:#cbd5e1"></i>backcountry</span>
    <span><i class="ring g"></i>open</span>
    <span><i class="ring r"></i>full</span>
    <span><i class="ring o"></i>stale</span>
  </div>
  <div id="aboutSources"></div>
  <p class="muted" id="aboutRefresh" style="font-size:12.5px;margin-top:10px"></p>
  <p class="muted" style="font-size:11px;margin-top:6px">Map © OpenStreetMap contributors, © CARTO.</p>
  <button id="aboutClose">Close</button>
</div></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(async () => {
  const COLOR={"Alberta Parks":"#f59e0b","Saskatchewan Parks":"#38bdf8","BC Parks":"#22c55e","Parks Canada":"#ef4444"};
  const RING={available:"#16a34a",full:"#dc2626",stale:"#f59e0b"};
  const $=id=>document.getElementById(id);
  const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const iso=d=>d.toISOString().slice(0,10);
  const addDays=(s,n)=>{const[y,m,d]=s.split("-").map(Number);const t=new Date(Date.UTC(y,m-1,d));t.setUTCDate(t.getUTCDate()+n);return iso(t)};
  const entries=[]; const entryById={};
  let bulk={}; let parkCount=0;

  // ----- prefs -----
  const prefs={start:localStorage.getItem("ce_start")||"",nights:+(localStorage.getItem("ce_nights")||2),hide:localStorage.getItem("ce_hide")==="1"};
  const elStart=$("start"),elNights=$("nights"),elHide=$("hideUnavail");
  elStart.min=iso(new Date()); elStart.value=prefs.start; elNights.value=prefs.nights; elHide.checked=prefs.hide;
  function savePrefs(){prefs.start=elStart.value;prefs.nights=Math.max(1,Math.min(14,+elNights.value||1));elNights.value=prefs.nights;prefs.hide=elHide.checked;
    localStorage.setItem("ce_start",prefs.start);localStorage.setItem("ce_nights",prefs.nights);localStorage.setItem("ce_hide",prefs.hide?"1":"0");}

  // ----- map -----
  const map=L.map("map",{zoomControl:false,attributionControl:false}).setView([54.5,-119],5);
  L.control.zoom({position:"bottomright"}).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19,attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);

  function icon(p,status){
    const c=COLOR[p.j]||"#64748b",back=p.t==="backcountry",s=back?12:13;
    const ring=status&&RING[status];
    const sh=ring?"box-shadow:0 0 0 1.5px #0b0f14,0 0 0 4px "+ring+";":"";
    const style="width:"+s+"px;height:"+s+"px;background:"+c+";border:1.5px solid #0b0f14;"+(back?"transform:rotate(45deg);":"border-radius:50%;")+sh;
    const r=s+(ring?8:0);
    return L.divIcon({className:"",html:'<div style="'+style+'"></div>',iconSize:[r,r],iconAnchor:[s/2,s/2],popupAnchor:[0,-s/2]});
  }
  function statusOf(p){const b=bulk[p.id]; if(!prefs.start||!b)return null; return b.stale?"stale":b.available?"available":"full";}
  function refreshPins(){
    for(const e of entries){
      const st=statusOf(e.p);
      e.status=st;
      const hideIt=prefs.hide&&prefs.start&&bulk[e.p.id]&&!bulk[e.p.id].available;
      if(hideIt){ if(map.hasLayer(e.m))e.m.remove(); }
      else { if(!map.hasLayer(e.m))e.m.addTo(map); e.m.setIcon(icon(e.p,st)); }
    }
    const lit=Object.keys(bulk).length;
    const msg = prefs.start ? (lit < entries.length ? "filling availability… "+lit+"/"+entries.length+" ready" : "") : "set arrive date ↑ to light up";
    $("sub").textContent = msg || (parkCount + " parks");
    $("mhint").textContent = msg;
  }
  async function lightUp(){
    if(!prefs.start){bulk={};refreshPins();return;}
    try{const r=await fetch("/api/availability-bulk?start="+prefs.start+"&nights="+prefs.nights);const d=await r.json();bulk=d.parks||{};}catch(e){bulk={};}
    refreshPins();
  }
  function onPrefsChanged(){savePrefs();lightUp();}
  elStart.onchange=onPrefsChanged; elNights.onchange=onPrefsChanged; elHide.onchange=()=>{savePrefs();refreshPins();};

  // ----- popup w/ mini-month -----
  function popupShell(p){
    const ll=p.lat.toFixed(5)+", "+p.lng.toFixed(5);
    return '<b>'+esc(p.name)+'</b><br><span class="tag">'+esc(p.j)+(p.t==="backcountry"?" · backcountry":"")+'</span>'+
      '<div class="ll"><span>'+ll+'</span><button data-ll="'+ll+'">copy</button></div>'+
      '<a class="book" href="'+esc(p.url)+'" target="_blank" rel="noopener">Book / official site →</a>'+
      '<div class="cal" data-cal></div><div class="desc muted" data-desc>Loading…</div>';
  }
  function renderCal(host,p){
    if(!prefs.start){host.innerHTML='<div class="mlabel">Set dates to see the month.</div>';return;}
    const gridStart=addDays(prefs.start,-(new Date(prefs.start+"T00:00:00Z").getUTCDay()));
    fetch("/api/calendar?id="+encodeURIComponent(p.id)+"&start="+gridStart+"&nights="+prefs.nights+"&days=42").then(r=>r.json()).then(c=>{
      if(!c.harvested){host.innerHTML='<div class="mlabel">No cached availability yet.</div>';return;}
      const wd=["S","M","T","W","T","F","S"].map(d=>'<div class="wd">'+d+'</div>').join("");
      const cells=c.cells.map(x=>{const day=+x.date.slice(8,10);const cls=x.siteCount<0?"none":x.available?"g":"r";return '<div class="d '+cls+'" title="'+x.date+(x.siteCount>=0?" · "+x.siteCount+" open":"")+'">'+day+'</div>';}).join("");
      const m=new Date(prefs.start+"T00:00:00Z").toLocaleDateString("en-CA",{month:"long",timeZone:"UTC"});
      host.innerHTML='<div class="mlabel"><span>'+m+' — '+prefs.nights+'n stays</span>'+(c.stale?'<span style="color:#f59e0b">stale</span>':'')+'</div><div class="grid">'+wd+cells+'</div>';
    }).catch(()=>{host.innerHTML='';});
  }

  // ----- load pins -----
  try{
    const r=await fetch("/api/campgrounds"); if(!r.ok)throw new Error("map data unavailable");
    const d=await r.json(); const grp=[];
    for(const p of d.pins){
      const m=L.marker([p.lat,p.lng],{icon:icon(p,null)}).bindPopup(popupShell(p));
      const e={m,p,status:null}; entries.push(e); entryById[p.id]=e;
      m.on("popupopen",()=>{
        const el=m.getPopup().getElement(); if(!el)return;
        const cb=el.querySelector("[data-ll] , .ll button"); const btn=el.querySelector(".ll button");
        if(btn&&!btn._w){btn._w=1;btn.addEventListener("click",()=>{navigator.clipboard&&navigator.clipboard.writeText(btn.dataset.ll).then(()=>btn.textContent="copied");});}
        renderCal(el.querySelector("[data-cal]"),p);
        const desc=el.querySelector("[data-desc]");
        if(m._info!==undefined){descSet(desc,m._info);}
        else fetch("/api/campground?id="+encodeURIComponent(p.id)).then(r=>r.ok?r.json():null).then(info=>{m._info=info;const d2=m.getPopup()&&m.getPopup().getElement()&&m.getPopup().getElement().querySelector("[data-desc]");if(d2)descSet(d2,info);}).catch(()=>{});
      });
      m.addTo(map); grp.push(m);
    }
    function descSet(el,info){ if(info&&info.description){el.className="desc";el.textContent=info.description;} else {el.className="desc muted";el.textContent="No description.";} }
    window.descSet=descSet;
    parkCount=d.count; $("sub").textContent=parkCount+" parks";
    if(grp.length)map.fitBounds(L.featureGroup(grp).getBounds().pad(0.05));
    await lightUp();
  }catch(e){$("sub").textContent="data unavailable";}

  // ----- modals -----
  const show=id=>$(id).classList.add("on"), hide=id=>$(id).classList.remove("on");
  $("aboutBtn").onclick=()=>{loadAbout();show("about");};
  $("aboutClose").onclick=()=>hide("about");
  $("welcomeOk").onclick=()=>{hide("welcome");localStorage.setItem("ce_seen","1");};
  $("welcomeAbout").onclick=()=>{hide("welcome");localStorage.setItem("ce_seen","1");loadAbout();show("about");};
  for(const id of ["welcome","about"])$(id).addEventListener("click",ev=>{if(ev.target.id===id)hide(id);});
  if(!localStorage.getItem("ce_seen"))show("welcome");
  function ago(ts){if(!ts)return"never";const s=(Date.now()-ts)/1000;if(s<3600)return Math.round(s/60)+"m ago";if(s<86400)return Math.round(s/3600)+"h ago";return Math.round(s/86400)+"d ago";}
  async function loadAbout(){
    try{const a=await(await fetch("/api/about")).json();
      $("aboutSources").innerHTML=Object.entries(a.bySource).map(([j,v])=>'<div class="src"><span><i class="dot" style="background:'+(COLOR[j]||"#64748b")+';display:inline-block;margin-right:6px"></i>'+esc(j)+' · '+v.harvested+' parks</span><span class="age">updated '+ago(v.newest)+'</span></div>').join("")||'<p class="muted">Harvest starting…</p>';
      $("aboutRefresh").textContent="BC & Parks Canada refresh every "+a.refresh.camisHours+"h, Alberta every "+a.refresh.albertaHours+"h, over a "+a.refresh.windowDays+"-day window. "+a.status.harvested+" parks cached"+(a.status.errors?", "+a.status.errors+" errors":"")+".";
    }catch(e){$("aboutSources").innerHTML='<p class="muted">status unavailable</p>';}
  }
})();
</script>
</body>
</html>`;
