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
  .fwrap{position:relative;display:flex;align-items:center}
  .fwrap .info{display:flex;align-items:center;justify-content:center}
  .fwrap .fdot{position:absolute;top:-1px;right:-1px;width:8px;height:8px;border-radius:50%;background:#22c55e;border:1.5px solid var(--panel);display:none}
  .fwrap.active .fdot{display:block}
  .fpop{position:absolute;top:calc(100% + 8px);right:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:12px 14px;display:none;flex-direction:column;gap:11px;min-width:172px;box-shadow:0 10px 30px #000a;z-index:1200}
  .fpop.open{display:flex}
  .fpop .grp{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px}
  .fpop label{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink);cursor:pointer;padding:2px 0}
  .fpop label+label{margin-top:2px}
  .fpop input{width:16px;height:16px;accent-color:#22c55e}
  .fpop .hr{height:1px;background:var(--line);margin:1px 0}
  .fpop .ptag{color:#34d399;font-size:10px;font-weight:600;white-space:nowrap}
  .pubdot{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 0 1.5px #0b0f14;display:inline-block}
  .theme-btn{width:34px;height:34px;background:var(--panel);border:1px solid var(--line);border-radius:9px;color:var(--ink);
    display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 8px 30px #0007;margin-bottom:8px}
  .theme-btn:hover{border-color:#3a4d66}
  .search{position:relative;display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);
    border-radius:13px;padding:8px 12px;backdrop-filter:blur(6px);box-shadow:0 8px 30px #0007;flex:1 1 190px;max-width:360px}
  .search svg{flex:none;color:var(--muted)}
  .search input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--ink);font-size:14px;font-family:inherit}
  .search input::placeholder{color:var(--muted)}
  .search .clr{flex:none;cursor:pointer;color:var(--muted);font-size:15px;line-height:1;display:none}
  .search.has .clr{display:block}
  .sresults{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--panel);border:1px solid var(--line);
    border-radius:11px;overflow:hidden auto;display:none;box-shadow:0 10px 30px #000a;z-index:1300;max-height:266px}
  .sresults.open{display:block}
  .sresults button{display:flex;align-items:center;width:100%;text-align:left;background:transparent;border:0;border-top:1px solid var(--line);
    color:var(--ink);font-size:13px;padding:8px 11px;cursor:pointer;font-family:inherit;line-height:1.25}
  .sresults button:first-child{border-top:0}
  .sresults button:hover,.sresults button.sel{background:#1a2433}
  .sresults .sdot{width:8px;height:8px;border-radius:50%;flex:none;margin-right:8px;box-shadow:0 0 0 1.5px #0b0f14}
  .sresults .sdot.place{background:transparent;box-shadow:inset 0 0 0 2px #64748b}
  .sresults .nm{font-weight:600}
  .sresults .rg{color:var(--muted);font-size:11px}
  .sresults .msg{padding:9px 11px;color:var(--muted);font-size:12.5px}
  .legend{position:absolute;z-index:1000;bottom:10px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 120px);
    background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:9px 20px;backdrop-filter:blur(6px)}
  .legend .keys{display:flex;gap:7px 13px;flex-wrap:wrap;justify-content:center;align-items:center;font-size:12.5px;color:#e8eef5}
  .legend .keys span{display:flex;align-items:center;gap:5px;white-space:nowrap}
  .legend .keys span:has(.ring){gap:9px}
  .keys b{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .keys .vsep{width:1px;height:16px;background:var(--line);margin:0 3px}
  .dot{width:11px;height:11px;border-radius:50%;box-shadow:0 0 0 1.5px #0b0f14}
  .dia{width:10px;height:10px;transform:rotate(45deg);box-shadow:0 0 0 1.5px #0b0f14}
  .ring{width:10px;height:10px;border-radius:50%;background:#64748b}
  .ring.g{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #16a34a}.ring.r{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #dc2626}
  .ring.o{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #f59e0b}
  .ring.p{box-shadow:0 0 0 2px #0b0f14,0 0 0 4px #64748b}
  .mhint{position:absolute;z-index:1000;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(13,20,32,.9);
    border:1px solid var(--line);color:var(--muted);font-size:11.5px;padding:4px 11px;border-radius:9px;display:none;white-space:nowrap}
  @media (max-width:560px){
    .legend{display:none}
    .brand{display:none}
    .search{flex-basis:100%;max-width:none;order:-1}
    .bar{top:8px;left:8px;right:8px;gap:8px;justify-content:flex-end}
    .mhint:not(:empty){display:block}
  }
  .abkeys{margin:12px 0 4px}
  .abkeys>div{display:flex;align-items:center;flex-wrap:wrap;gap:8px 13px;padding:7px 0;font-size:13px;color:#e8eef5;border-top:1px solid var(--line)}
  .abkeys>div:first-child{border-top:0}
  .abkeys>div b{color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;width:46px;flex:none}
  .abkeys span{display:flex;align-items:center;gap:5px}
  .card code{background:#0a0e14;border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:12px;color:#a78bfa;word-break:break-all}
  /* modal */
  .modal{position:fixed;inset:0;z-index:2000;background:#0008;display:none;align-items:center;justify-content:center;padding:18px}
  .modal.on{display:flex}
  .card{background:#0e1622;border:1px solid var(--line);border-radius:18px;max-width:540px;width:100%;
    padding:26px 28px;box-shadow:0 30px 80px #000a;max-height:88vh;overflow:auto}
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
  <div class="search" id="searchWrap">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.2-4.2"/></svg>
    <input id="searchInput" type="text" placeholder="Search a place…" autocomplete="off" enterkeyhint="search" aria-label="Search a place">
    <span class="clr" id="searchClear" title="Clear">✕</span>
    <div class="sresults" id="sresults"></div>
  </div>
  <div class="ctl">
    <label>Arrive<input type="date" id="start"></label>
    <label>Nights<input type="number" id="nights" min="1" max="14" value="2"></label>
    <div class="fwrap" id="fwrap">
      <div class="info" id="filterBtn" title="Filters">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>
      </div>
      <span class="fdot"></span>
      <div class="fpop" id="fpop">
        <div><div class="grp">Type</div>
          <label><input type="checkbox" id="fFront" checked>Front-country</label>
          <label><input type="checkbox" id="fBack" checked>Backcountry</label></div>
        <div class="hr"></div>
        <label><input type="checkbox" id="hideUnavail">Open only</label>
        <div class="hr"></div>
        <label><input type="checkbox" id="fPublic"><span>Free / public land <span class="ptag">● free</span></span></label>
      </div>
    </div>
    <div class="info" id="aboutBtn" title="About &amp; legend">?</div>
  </div>
</div>
<div class="legend"><div class="keys">
  <b>Source</b>
  <span><i class="dot" style="background:#f59e0b"></i>AB</span>
  <span><i class="dot" style="background:#38bdf8"></i>SK</span>
  <span><i class="dot" style="background:#22c55e"></i>BC</span>
  <span><i class="dot" style="background:#ef4444"></i>PC</span>
  <i class="vsep"></i>
  <b>Type</b>
  <span><i class="dot" style="background:#cbd5e1"></i>front</span>
  <span><i class="dia" style="background:#cbd5e1"></i>back</span>
  <span><i class="pubdot"></i>free</span>
  <i class="vsep"></i>
  <b>Avail</b>
  <span><i class="ring g"></i>open</span>
  <span><i class="ring r"></i>full</span>
</div></div>
<div class="mhint" id="mhint"></div>

<div class="modal" id="welcome"><div class="card">
  <h2><img src="/favicon.svg" alt="">Camp, Eh?</h2>
  <p>Campsite availability across <b>Alberta Parks</b>, <b>BC Parks</b>, and <b>Parks Canada</b> — including backcountry and trails like the West Coast Trail — on one map.</p>
  <ul>
    <li>Pick an <b>arrive date + nights</b> up top.</li>
    <li>The map <b>lights up</b>: green = open, red = full, orange = a bit stale, grey = data still filling deeper for that date.</li>
    <li>Use the <b>filter</b> (funnel icon) for open-only, or front/backcountry.</li>
    <li>Tap a pin for a <b>colored month view</b> + booking link.</li>
  </ul>
  <button id="welcomeOk">Let's go</button> <a id="welcomeAbout" style="margin-left:8px">how it works</a>
</div></div>

<div class="modal" id="about"><div class="card">
  <div style="text-align:center;margin-bottom:4px"><img src="/favicon.svg" alt="Camp, Eh?" style="width:58px;height:58px"></div>
  <h2 style="justify-content:center">Camp, Eh?</h2>
  <p>A read-only mirror of campground reservation systems, refreshed on a schedule so lookups are instant. Availability can lag the official sites — always confirm before you book.</p>
  <div class="abkeys">
    <div><b>Source</b>
      <span><i class="dot" style="background:#f59e0b"></i>Alberta</span>
      <span><i class="dot" style="background:#38bdf8"></i>Saskatchewan</span>
      <span><i class="dot" style="background:#22c55e"></i>BC</span>
      <span><i class="dot" style="background:#ef4444"></i>Parks Canada</span></div>
    <div><b>Type</b>
      <span><i class="dot" style="background:#cbd5e1"></i>front-country</span>
      <span><i class="dia" style="background:#cbd5e1"></i>backcountry</span>
      <span><i class="pubdot"></i>free / public land</span></div>
    <div><b>Avail</b>
      <span><i class="ring g"></i>open</span>
      <span><i class="ring r"></i>full</span>
      <span><i class="ring o"></i>stale</span>
      <span><i class="ring p"></i>filling</span></div>
  </div>
  <div id="aboutSources"></div>
  <p class="muted" id="aboutRefresh" style="font-size:12.5px;margin-top:10px"></p>
  <p id="aboutMcp" style="font-size:12.5px;margin-top:8px"></p>
  <p class="muted" style="font-size:12px;margin-top:8px"><b>● Free / public land</b> (filter funnel) shows free, first-come-first-served camping: ~1,200 BC Recreation Sites &amp; Trails plus ~3,100 free/dispersed sites from OpenStreetMap nationwide, and Alberta's Crown-land Public Land Camping Pass area as a shaded zone. No live availability — always check local rules &amp; fire bans.</p>
  <p class="muted" style="font-size:11px;margin-top:6px">Map © OpenStreetMap contributors, © CARTO. Free sites contain information licensed under the Open Government Licence – British Columbia and the Open Government Licence – Alberta, plus © OpenStreetMap contributors (ODbL).</p>
  <button id="aboutClose">Close</button>
</div></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(async () => {
  const COLOR={"Alberta Parks":"#f59e0b","Saskatchewan Parks":"#38bdf8","BC Parks":"#22c55e","Parks Canada":"#ef4444"};
  const RING={available:"#16a34a",full:"#dc2626",stale:"#f59e0b",pending:"#64748b"};
  const $=id=>document.getElementById(id);
  const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const iso=d=>d.toISOString().slice(0,10);
  const addDays=(s,n)=>{const[y,m,d]=s.split("-").map(Number);const t=new Date(Date.UTC(y,m-1,d));t.setUTCDate(t.getUTCDate()+n);return iso(t)};
  const entries=[]; const entryById={};
  let bulk={}; let parkCount=0;

  // ----- prefs -----
  const prefs={start:localStorage.getItem("ce_start")||"",nights:+(localStorage.getItem("ce_nights")||2),hide:localStorage.getItem("ce_hide")==="1",
    front:localStorage.getItem("ce_front")!=="0",back:localStorage.getItem("ce_back")!=="0",pub:localStorage.getItem("ce_pub")==="1",
    theme:localStorage.getItem("ce_theme")||"dark"};
  // URL hash overrides localStorage so a page can be bookmarked/shared (#m=lat,lng,z&d=date&n=nights&f=flags)
  const hp=new URLSearchParams(location.hash.slice(1));
  if(hp.has("d")&&/^\d{4}-\d{2}-\d{2}$/.test(hp.get("d")))prefs.start=hp.get("d");
  if(hp.has("n"))prefs.nights=Math.max(1,Math.min(14,+hp.get("n")||prefs.nights));
  if(hp.has("f")){const f=hp.get("f");prefs.front=f.includes("f");prefs.back=f.includes("b");prefs.hide=f.includes("o");prefs.pub=f.includes("p");}
  const elStart=$("start"),elNights=$("nights"),elHide=$("hideUnavail"),elFront=$("fFront"),elBack=$("fBack"),elPublic=$("fPublic");
  elStart.min=iso(new Date()); elStart.value=prefs.start; elNights.value=prefs.nights; elHide.checked=prefs.hide; elFront.checked=prefs.front; elBack.checked=prefs.back; elPublic.checked=prefs.pub;
  function savePrefs(){prefs.start=elStart.value;prefs.nights=Math.max(1,Math.min(14,+elNights.value||1));elNights.value=prefs.nights;
    prefs.hide=elHide.checked;prefs.front=elFront.checked;prefs.back=elBack.checked;prefs.pub=elPublic.checked;
    localStorage.setItem("ce_start",prefs.start);localStorage.setItem("ce_nights",prefs.nights);localStorage.setItem("ce_hide",prefs.hide?"1":"0");
    localStorage.setItem("ce_front",prefs.front?"1":"0");localStorage.setItem("ce_back",prefs.back?"1":"0");localStorage.setItem("ce_pub",prefs.pub?"1":"0");
    $("fwrap").classList.toggle("active",prefs.hide||!prefs.front||!prefs.back||prefs.pub);queueHash();}

  // ----- map -----
  const map=L.map("map",{zoomControl:false,attributionControl:false});
  const CANADA=[[43,-141],[60,-52]]; // southern band, coast to coast
  let viewSet=false;
  if(hp.has("m")){const a=hp.get("m").split(",").map(Number);if(a.length>=3&&a.every(x=>!isNaN(x))){map.setView([a[0],a[1]],Math.max(3,Math.min(18,a[2])));viewSet=true;}}
  if(!viewSet)map.fitBounds(CANADA);
  L.control.zoom({position:"bottomright"}).addTo(map);
  // keep the URL in sync (debounced) so the current view + filters are bookmarkable
  let hashTimer=null;
  function writeHash(){
    const c=map.getCenter(),z=map.getZoom();
    const p=new URLSearchParams();
    p.set("m",c.lat.toFixed(4)+","+c.lng.toFixed(4)+","+z);
    if(prefs.start)p.set("d",prefs.start);
    p.set("n",prefs.nights);
    p.set("f",(prefs.front?"f":"")+(prefs.back?"b":"")+(prefs.hide?"o":"")+(prefs.pub?"p":""));
    history.replaceState(null,"","#"+p.toString());
  }
  function queueHash(){clearTimeout(hashTimer);hashTimer=setTimeout(writeHash,400);}
  map.on("moveend",queueHash);
  // Basemap themes — dark (default) and a lighter, more legible Voyager map.
  const TILES={
    dark:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    light:"https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  };
  const SUN='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19"/></svg>';
  const MOON='<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.8A8.5 8.5 0 0111.2 3a7 7 0 109.8 9.8z"/></svg>';
  let baseLayer=null;
  function setBasemap(theme){
    prefs.theme=theme==="light"?"light":"dark";
    if(baseLayer)baseLayer.remove();
    baseLayer=L.tileLayer(TILES[prefs.theme],{maxZoom:19,attribution:'&copy; OpenStreetMap &copy; CARTO'}).addTo(map);
    baseLayer.bringToBack();
    document.body.classList.toggle("lightmap",prefs.theme==="light");
    localStorage.setItem("ce_theme",prefs.theme);
    const b=$("themeBtn"); if(b)b.innerHTML=prefs.theme==="light"?MOON:SUN;
  }
  const ThemeCtl=L.Control.extend({onAdd:function(){const b=L.DomUtil.create("button","theme-btn");b.id="themeBtn";b.title="Toggle map theme";b.innerHTML=prefs.theme==="light"?MOON:SUN;L.DomEvent.disableClickPropagation(b);L.DomEvent.on(b,"click",()=>setBasemap(prefs.theme==="light"?"dark":"light"));return b;}});
  new ThemeCtl({position:"bottomright"}).addTo(map);
  setBasemap(prefs.theme);

  function icon(p,status){
    const c=COLOR[p.j]||"#64748b",back=p.t==="backcountry",s=back?12:13;
    const ring=status&&RING[status];
    const sh=ring?"box-shadow:0 0 0 1.5px #0b0f14,0 0 0 4px "+ring+";":"";
    const style="width:"+s+"px;height:"+s+"px;background:"+c+";border:1.5px solid #0b0f14;"+(back?"transform:rotate(45deg);":"border-radius:50%;")+sh;
    const r=s+(ring?8:0);
    return L.divIcon({className:"",html:'<div style="'+style+'"></div>',iconSize:[r,r],iconAnchor:[s/2,s/2],popupAnchor:[0,-s/2]});
  }
  function statusOf(p){const b=bulk[p.id]; if(!prefs.start||!b)return null; if(b.pending)return "pending"; return b.stale?"stale":b.available?"available":"full";}
  function refreshPins(){
    for(const e of entries){
      const st=statusOf(e.p);
      e.status=st;
      const back=e.p.t==="backcountry";
      const typeHidden=(back&&!prefs.back)||(!back&&!prefs.front);
      const hideIt=typeHidden||(prefs.hide&&prefs.start&&bulk[e.p.id]&&!bulk[e.p.id].available);
      if(hideIt){ if(map.hasLayer(e.m))e.m.remove(); }
      else { if(!map.hasLayer(e.m))e.m.addTo(map); e.m.setIcon(icon(e.p,st)); }
    }
    const lit=Object.keys(bulk).filter(k=>!bulk[k].pending).length;
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
  elStart.onchange=onPrefsChanged; elNights.onchange=onPrefsChanged;
  for(const el of [elHide,elFront,elBack])el.onchange=()=>{savePrefs();refreshPins();};
  elPublic.onchange=()=>{savePrefs();syncPublic();};
  $("fwrap").classList.toggle("active",prefs.hide||!prefs.front||!prefs.back||prefs.pub);

  // ----- free / public-land layer (BC Rec Sites + OSM points; AB Crown-land zones) -----
  // Canvas renderer keeps thousands of free-camp points smooth.
  const pubRenderer=L.canvas({padding:0.5});
  const pubLayer=L.layerGroup();   // free-camp points
  const zoneLayer=L.layerGroup();  // Crown-land "camping allowed/pass" zones
  let pubLoaded=false,zoneLoaded=false;
  function pubPopup(s){
    const ll=s.lat.toFixed(5)+", "+s.lng.toFixed(5);
    return '<b>'+esc(s.name)+'</b><br><span class="tag">▲ '+esc(s.source)+(s.town?' · '+esc(s.town):'')+'</span>'+
      (s.sites?'<div class="muted" style="font-size:12px;margin-top:3px">'+s.sites+' designated site'+(s.sites>1?'s':'')+'</div>':'')+
      '<div class="muted" style="font-size:12px;margin-top:3px">Free · first-come, first-served. Check local rules &amp; fire bans.</div>'+
      '<div class="ll"><span>'+ll+'</span><button data-ll="'+ll+'">copy</button></div>'+
      '<a class="book" href="https://www.google.com/maps/search/?api=1&query='+s.lat+','+s.lng+'" target="_blank" rel="noopener">Directions →</a>';
  }
  function loadPubPoints(){
    return fetch("/api/publiclands").then(r=>r.json()).then(d=>{
      for(const s of (d.sites||[])){
        const mk=L.circleMarker([s.lat,s.lng],{renderer:pubRenderer,radius:4,weight:1,color:"#0b0f14",fillColor:"#34d399",fillOpacity:.9}).bindPopup(pubPopup(s));
        mk.on("popupopen",()=>{const el=mk.getPopup().getElement();const b=el&&el.querySelector(".ll button");
          if(b&&!b._w){b._w=1;b.addEventListener("click",()=>{navigator.clipboard&&navigator.clipboard.writeText(b.dataset.ll).then(()=>b.textContent="copied");});}});
        mk.addTo(pubLayer);
      }
      pubLoaded=true;
    }).catch(()=>{});
  }
  function loadZones(){
    return fetch("/api/publiclands/zones").then(r=>r.json()).then(gj=>{
      L.geoJSON(gj,{style:{color:"#34d399",weight:1,fillColor:"#34d399",fillOpacity:.08},
        onEachFeature:(f,lyr)=>{const nm=(f.properties&&f.properties.Name)||"Public-land camping area";
          lyr.bindPopup('<b>'+esc(nm)+'</b><br><span class="tag">Alberta Crown land</span>'+
            '<div class="muted" style="font-size:12px;margin-top:3px">Random camping in this region generally needs a <b>Public Land Camping Pass</b>. Check current rules &amp; fire bans.</div>');}
      }).addTo(zoneLayer);
      zoneLoaded=true;
    }).catch(()=>{});
  }
  async function syncPublic(){
    if(prefs.pub){
      if(!zoneLoaded)await loadZones();
      if(!pubLoaded)await loadPubPoints();
      if(!map.hasLayer(zoneLayer))zoneLayer.addTo(map);
      if(!map.hasLayer(pubLayer))pubLayer.addTo(map);
    } else {
      if(map.hasLayer(pubLayer))map.removeLayer(pubLayer);
      if(map.hasLayer(zoneLayer))map.removeLayer(zoneLayer);
    }
  }
  syncPublic();
  $("filterBtn").onclick=(ev)=>{ev.stopPropagation();$("fpop").classList.toggle("open");};
  $("fpop").addEventListener("click",ev=>ev.stopPropagation());
  document.addEventListener("click",()=>$("fpop").classList.remove("open"));

  // ----- search: our campgrounds (instant) blended with geocoded places -----
  const sInput=$("searchInput"),sRes=$("sresults"),sWrap=$("searchWrap");
  let sTimer=null,sHits=[],sSel=-1;
  function flyTo(h){
    if(h.bbox)map.fitBounds([[h.bbox[0],h.bbox[2]],[h.bbox[1],h.bbox[3]]],{maxZoom:13,padding:[40,40]});
    else map.setView([h.lat,h.lng],h.kind==="pin"?13:11);
  }
  function closeRes(){sRes.classList.remove("open");sSel=-1;}
  // Rank our pins: name starts-with the query beats a mid-name match.
  function localMatches(q){
    const nq=q.toLowerCase();
    return entries
      .filter(e=>e.p.lat!=null&&e.p.name.toLowerCase().includes(nq))
      .sort((a,b)=>(a.p.name.toLowerCase().startsWith(nq)?0:1)-(b.p.name.toLowerCase().startsWith(nq)?0:1)||a.p.name.localeCompare(b.p.name))
      .slice(0,6)
      .map(e=>({kind:"pin",name:e.p.name,lat:e.p.lat,lng:e.p.lng,j:e.p.j,entry:e}));
  }
  function renderRes(){
    if(!sHits.length){sRes.innerHTML='<div class="msg">No matches.</div>';sRes.classList.add("open");return;}
    sRes.innerHTML=sHits.map((h,i)=>{
      if(h.kind==="pin")return '<button data-i="'+i+'"><i class="sdot" style="background:'+(COLOR[h.j]||"#64748b")+'"></i><span class="nm">'+esc(h.name)+'</span></button>';
      const parts=h.name.split(", ");const rg=parts.slice(1,3).join(", ");
      return '<button data-i="'+i+'"><i class="sdot place"></i><span class="nm">'+esc(parts[0])+'</span>'+(rg?' <span class="rg">'+esc(rg)+'</span>':'')+'</button>';
    }).join("");
    sRes.classList.add("open");
  }
  async function doSearch(q){
    try{const r=await fetch("/api/geocode?q="+encodeURIComponent(q));const d=await r.json();
      const places=(d.hits||[]).map(h=>({kind:"place",name:h.name,lat:h.lat,lng:h.lng,bbox:h.bbox}));
      sHits=[...localMatches(q),...places].slice(0,9);sSel=-1;renderRes();
    }catch(e){/* keep the instant local matches */}
  }
  function pick(h){
    if(h.kind==="pin"){map.setView([h.lat,h.lng],Math.max(map.getZoom(),13));if(h.entry&&map.hasLayer(h.entry.m))h.entry.m.openPopup();sInput.value=h.name;}
    else{flyTo(h);sInput.value=h.name.split(", ")[0];}
    closeRes();sInput.blur();
  }
  sInput.addEventListener("input",()=>{
    const q=sInput.value.trim();sWrap.classList.toggle("has",!!q);clearTimeout(sTimer);
    if(q.length<2){closeRes();sHits=[];return;}
    sHits=localMatches(q);renderRes();      // instant park matches
    sTimer=setTimeout(()=>doSearch(q),320); // then blend in geocoded places
  });
  sInput.addEventListener("keydown",ev=>{
    if((ev.key==="ArrowDown"||ev.key==="ArrowUp")&&sHits.length){ev.preventDefault();
      sSel=(sSel+(ev.key==="ArrowDown"?1:-1)+sHits.length)%sHits.length;
      [...sRes.querySelectorAll("button")].forEach((b,i)=>b.classList.toggle("sel",i===sSel));}
    else if(ev.key==="Enter"){ev.preventDefault();const h=sHits[sSel>=0?sSel:0];if(h)pick(h);}
    else if(ev.key==="Escape"){closeRes();sInput.blur();}
  });
  sRes.addEventListener("click",ev=>{const b=ev.target.closest("button[data-i]");if(b&&sHits[+b.dataset.i])pick(sHits[+b.dataset.i]);});
  sInput.addEventListener("focus",()=>{if(sHits.length)sRes.classList.add("open");});
  $("searchClear").addEventListener("click",()=>{sInput.value="";sWrap.classList.remove("has");sHits=[];closeRes();sInput.focus();});
  document.addEventListener("click",ev=>{if(!sWrap.contains(ev.target))closeRes();});
  queueHash();

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
    // Initial view is set once up front: #m=lat,lng,z from the URL, else all of Canada.
    // Don't re-fit to pins here — that would override a bookmarked position/zoom.
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
      $("aboutRefresh").textContent="Refreshed adaptively over a "+a.refresh.windowDays+"-day window — parks near capacity every few hours, quiet ones up to ~daily. "+a.status.harvested+" parks cached"+(a.status.errors?", "+a.status.errors+" errors":"")+".";
      $("aboutMcp").innerHTML='Connect an AI assistant (MCP): <code>'+esc(location.origin+(a.mcpPath||"/mcp"))+'</code>';
    }catch(e){$("aboutSources").innerHTML='<p class="muted">status unavailable</p>';}
  }
})();
</script>
</body>
</html>`;
