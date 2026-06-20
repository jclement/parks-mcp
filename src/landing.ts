// Mobile-friendly Leaflet map of campgrounds. Pins are colored by jurisdiction and
// shaped by type (round = front-country, diamond = backcountry). Clicking a pin opens
// a detail popup (copyable lat/long, booking link, lazy description, and — when dates
// are set — a per-pin availability check). With dates set you can also sweep the
// visible area: every pin in view is checked and ringed green (available) / red (full).
// Pulls /api/campgrounds, /api/campground, /api/availability.
export const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Campground Map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>
  html,body { margin:0; height:100%; background:#0b0f14; color:#e8eef5;
    font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  #map { position:absolute; inset:0; }
  .panel { position:absolute; z-index:1000; top:12px; left:12px; right:12px; max-width:340px;
    background:rgba(13,20,32,.93); border:1px solid #1f2a3a; border-radius:14px; padding:11px 14px;
    backdrop-filter:blur(6px); box-shadow:0 10px 40px #0007; }
  .panel h1 { margin:0 0 2px; font-size:16px; }
  .panel .s { color:#8aa0b8; font-size:12.5px; }
  .dates { display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; align-items:flex-end; }
  .dates label { font-size:11px; color:#8aa0b8; display:flex; flex-direction:column; gap:3px; }
  .dates input { background:#0b0f14; color:#e8eef5; border:1px solid #2a3a4f; border-radius:8px;
    padding:6px 8px; font-size:14px; font-family:inherit; }
  .dates input#dNights { width:58px; }
  #areaBtn { cursor:pointer; background:#7c3aed; color:#fff; border:0; font-weight:600;
    border-radius:9px; font-size:13px; padding:8px 11px; }
  #areaBtn[disabled] { opacity:.45; cursor:default; }
  .hint { color:#64748b; font-size:11px; margin-top:7px; min-height:14px; }
  .legend { display:flex; gap:13px; flex-wrap:wrap; margin-top:9px; font-size:12px; color:#cbd5e1; }
  .legend span { display:flex; align-items:center; gap:5px; }
  .dot { width:11px; height:11px; border-radius:50%; box-shadow:0 0 0 1.5px #0b0f14; }
  .dia { width:10px; height:10px; transform:rotate(45deg); box-shadow:0 0 0 1.5px #0b0f14; }
  .ring { width:11px; height:11px; border-radius:50%; background:#94a3b8; }
  .ring.g { box-shadow:0 0 0 2px #0b0f14, 0 0 0 4px #16a34a; }
  .ring.r { box-shadow:0 0 0 2px #0b0f14, 0 0 0 4px #dc2626; }
  .leaflet-popup-content { margin:11px 13px; font-size:13px; line-height:1.45; min-width:218px; }
  .leaflet-popup-content b { font-size:14px; }
  .leaflet-popup-content .tag { display:inline-block; font-size:11px; color:#8aa0b8; margin-top:2px; }
  .leaflet-popup-content a.book { display:block; margin-top:9px; color:#7c3aed; font-weight:600; }
  .leaflet-popup-content .ll { display:flex; align-items:center; gap:8px; margin:8px 0 0; width:fit-content;
    font-family:ui-monospace,monospace; font-size:12px; color:#334155; background:#f1f5f9;
    border:1px solid #e2e8f0; border-radius:8px; padding:4px 5px 4px 9px; }
  .leaflet-popup-content .ll button { cursor:pointer; background:#e2e8f0; color:#334155; border:0;
    border-radius:6px; font-size:11px; font-weight:600; padding:3px 9px; }
  .leaflet-popup-content .desc { color:#334155; margin-top:8px; max-height:150px; overflow:auto; }
  .leaflet-popup-content .muted { color:#94a3b8; }
  .leaflet-popup-content .avail { margin-top:10px; }
  .leaflet-popup-content .checkbtn { cursor:pointer; background:#7c3aed; color:#fff; border:0; font-weight:600;
    border-radius:8px; font-size:12.5px; padding:6px 11px; }
  .leaflet-popup-content .checkbtn[disabled] { opacity:.6; cursor:default; }
  .leaflet-popup-content .result { font-size:13px; margin-left:8px; }
  .leaflet-container { background:#0b0f14; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>🏕️ Campground Map</h1>
  <div class="s" id="sub">Loading…</div>
  <div class="dates">
    <label>Arrive<input type="date" id="dStart"></label>
    <label>Nights<input type="number" id="dNights" min="1" max="14" value="2"></label>
    <button id="areaBtn" disabled>Check this area</button>
  </div>
  <div class="hint" id="hint">Set dates to check availability.</div>
  <div class="legend">
    <span><i class="dot" style="background:#f59e0b"></i>AB</span>
    <span><i class="dot" style="background:#22c55e"></i>BC</span>
    <span><i class="dot" style="background:#ef4444"></i>PC</span>
    <span><i class="dot" style="background:#cbd5e1"></i>front · <i class="dia" style="background:#cbd5e1"></i>back</span>
    <span><i class="ring g"></i>open · <i class="ring r"></i>full</span>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(async () => {
  const COLOR = { "Alberta Parks":"#f59e0b", "BC Parks":"#22c55e", "Parks Canada":"#ef4444" };
  const RING = { available:"#16a34a", unavailable:"#dc2626", checking:"#eab308" };
  const AREA_CAP = 40;
  const $ = id => document.getElementById(id);
  const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const entries = [];  // { m, p, status }

  // ----- preferred dates (persisted) -----
  const prefs = { start: localStorage.getItem("pm_start")||"", nights: +(localStorage.getItem("pm_nights")||2) };
  const dStart = $("dStart"), dNights = $("dNights");
  dStart.min = new Date().toISOString().slice(0,10);
  dStart.value = prefs.start; dNights.value = prefs.nights;
  function save() {
    prefs.start = dStart.value;
    prefs.nights = Math.max(1, Math.min(14, +dNights.value || 1)); dNights.value = prefs.nights;
    localStorage.setItem("pm_start", prefs.start); localStorage.setItem("pm_nights", prefs.nights);
    $("areaBtn").disabled = !prefs.start;
    $("hint").textContent = prefs.start
      ? "Pan to an area, then \\u2018Check this area\\u2019, or click a pin."
      : "Set dates to check availability.";
    for (const e of entries) if (e.status) { e.status = null; e.m.setIcon(icon(e.p, null)); }  // dates changed → clear rings
  }
  dStart.onchange = save; dNights.onchange = save;

  window.pmCheck = async (id, btn) => {
    const out = btn.nextElementSibling;
    btn.disabled = true; out.textContent = "checking\\u2026"; out.className = "result muted";
    try {
      const r = await fetch("/api/availability?id=" + encodeURIComponent(id) + "&start=" + prefs.start + "&nights=" + prefs.nights);
      const d = await r.json(); if (!r.ok) throw 0;
      out.innerHTML = d.available
        ? '<b style="color:#16a34a">\\u2713 ' + d.siteCount + ' site' + (d.siteCount===1?'':'s') + ' open</b>'
        : '<b style="color:#dc2626">\\u2715 none open</b>';
    } catch (e) { out.innerHTML = '<span class="muted">check failed</span>'; }
    btn.disabled = false;
  };

  // ----- map -----
  const map = L.map("map", { zoomControl:true }).setView([54.5,-119], 5);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom:19, attribution:'&copy; OpenStreetMap &copy; CARTO' }).addTo(map);

  function icon(p, status) {
    const c = COLOR[p.j] || "#64748b", back = p.t === "backcountry", s = back ? 12 : 13;
    const ring = status && RING[status];
    const shadow = ring ? "box-shadow:0 0 0 1.5px #0b0f14,0 0 0 4px " + ring + ";" : "";
    const style = "width:" + s + "px;height:" + s + "px;background:" + c + ";border:1.5px solid #0b0f14;" +
      (back ? "transform:rotate(45deg);" : "border-radius:50%;") + shadow;
    const r = s + (ring ? 8 : 0);
    return L.divIcon({ className:"", html:'<div style="' + style + '"></div>',
      iconSize:[r,r], iconAnchor:[s/2,s/2], popupAnchor:[0,-s/2] });
  }
  function popupHtml(p, info) {
    const ll = p.lat.toFixed(5) + ", " + p.lng.toFixed(5);
    const desc = info === undefined ? '<div class="desc muted">Loading details\\u2026</div>'
      : (info && info.description ? '<div class="desc">' + esc(info.description) + '</div>' : '<div class="desc muted">No description.</div>');
    const avail = prefs.start
      ? '<div class="avail"><button class="checkbtn" onclick="pmCheck(\\'' + esc(p.id) + '\\',this)">Check ' + prefs.start + ' \\u00b7 ' + prefs.nights + 'n</button><span class="result"></span></div>'
      : '';
    return '<b>' + esc(p.name) + '</b><br><span class="tag">' + esc(p.j) + (p.t==="backcountry"?" \\u00b7 backcountry":"") + '</span>' +
      '<div class="ll"><span>' + ll + '</span><button onclick="navigator.clipboard&&navigator.clipboard.writeText(\\'' + ll + '\\').then(()=>{this.textContent=\\'copied\\'})">copy</button></div>' +
      '<a class="book" href="' + esc(p.url) + '" target="_blank" rel="noopener">Book / full availability \\u2192</a>' + avail + desc;
  }

  // ----- sweep the visible area -----
  function setStatus(e, status) { e.status = status; e.m.setIcon(icon(e.p, status)); }
  async function checkArea() {
    if (!prefs.start) return;
    const b = map.getBounds();
    let inView = entries.filter(e => b.contains(e.m.getLatLng()));
    const extra = inView.length > AREA_CAP ? " (first " + AREA_CAP + " of " + inView.length + "; zoom in for more)" : "";
    inView = inView.slice(0, AREA_CAP);
    if (!inView.length) { $("hint").textContent = "No campgrounds in view — pan/zoom to an area."; return; }
    $("areaBtn").disabled = true;
    inView.forEach(e => setStatus(e, "checking"));
    let done = 0, open = 0;
    const tick = () => $("hint").textContent = "checked " + done + "/" + inView.length + extra + " \\u00b7 " + open + " open";
    tick();
    let i = 0;
    async function worker() {
      while (i < inView.length) {
        const e = inView[i++];
        try {
          const r = await fetch("/api/availability?id=" + encodeURIComponent(e.p.id) + "&start=" + prefs.start + "&nights=" + prefs.nights);
          const d = await r.json();
          const ok = r.ok && d.available;
          setStatus(e, ok ? "available" : "unavailable");
          if (ok) open++;
        } catch (err) { setStatus(e, "unavailable"); }
        done++; tick();
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    $("areaBtn").disabled = false;
  }
  $("areaBtn").onclick = checkArea;

  try {
    const r = await fetch("/api/campgrounds"); if (!r.ok) throw new Error("map data unavailable");
    const d = await r.json();
    const group = [];
    for (const p of d.pins) {
      const m = L.marker([p.lat, p.lng], { icon: icon(p, null) }).bindPopup(popupHtml(p));
      const entry = { m, p, status: null };
      m.on("popupopen", async () => {
        m.setPopupContent(popupHtml(p, m._info));
        if (m._info === undefined) {
          try { const ir = await fetch("/api/campground?id=" + encodeURIComponent(p.id)); m._info = ir.ok ? await ir.json() : null; }
          catch { m._info = null; }
          if (map.hasLayer(m) && m.isPopupOpen()) m.setPopupContent(popupHtml(p, m._info));
        }
      });
      m.addTo(map); group.push(m); entries.push(entry);
    }
    $("sub").textContent = d.pins.length.toLocaleString() + " of " + d.total.toLocaleString() + " campgrounds mapped";
    if (group.length) map.fitBounds(L.featureGroup(group).getBounds().pad(0.05));
  } catch (e) {
    $("sub").textContent = "Map data unavailable — " + (e.message || e);
  }
  save();
})();
</script>
</body>
</html>`;
