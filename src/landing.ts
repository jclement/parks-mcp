// Mobile-friendly Leaflet map of campgrounds. Pins are colored by jurisdiction and
// shaped by type (round = front-country, diamond = backcountry). Clicking a pin opens
// a detail popup with copyable lat/long, a booking link, and a lazily-loaded
// description. Pulls /api/campgrounds (+ /api/campground?id= for details).
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
    background:rgba(13,20,32,.92); border:1px solid #1f2a3a; border-radius:14px; padding:11px 14px;
    backdrop-filter:blur(6px); box-shadow:0 10px 40px #0007; }
  .panel h1 { margin:0 0 2px; font-size:16px; }
  .panel .s { color:#8aa0b8; font-size:12.5px; }
  .legend { display:flex; gap:13px; flex-wrap:wrap; margin-top:9px; font-size:12px; color:#cbd5e1; }
  .legend span { display:flex; align-items:center; gap:5px; }
  .dot { width:11px; height:11px; border-radius:50%; box-shadow:0 0 0 1.5px #0b0f14; }
  .dia { width:10px; height:10px; transform:rotate(45deg); box-shadow:0 0 0 1.5px #0b0f14; }
  .pin { box-sizing:border-box; }
  .pin.bc-shape { border-radius:2px; transform:rotate(45deg); }
  .leaflet-popup-content { margin:11px 13px; font-size:13px; line-height:1.45; min-width:210px; }
  .leaflet-popup-content b { font-size:14px; }
  .leaflet-popup-content .tag { display:inline-block; font-size:11px; color:#8aa0b8; margin-top:2px; }
  .leaflet-popup-content a.book { display:block; margin-top:9px; color:#a78bfa; font-weight:600; }
  .leaflet-popup-content .ll { display:flex; align-items:center; gap:6px; margin:8px 0 0; width:fit-content;
    font-family:ui-monospace,monospace; font-size:12px; background:#0b0f14; border:1px solid #1f2a3a;
    border-radius:7px; padding:3px 7px; }
  .leaflet-popup-content .ll button { cursor:pointer; background:#1f2a3a; color:#e8eef5; border:0;
    border-radius:5px; font-size:11px; padding:2px 7px; }
  .leaflet-popup-content .desc { color:#cbd5e1; margin-top:7px; max-height:160px; overflow:auto; }
  .leaflet-popup-content .muted { color:#64748b; }
  .leaflet-container { background:#0b0f14; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>🏕️ Campground Map</h1>
  <div class="s" id="sub">Loading…</div>
  <div class="legend">
    <span><i class="dot" style="background:#f59e0b"></i>Alberta</span>
    <span><i class="dot" style="background:#22c55e"></i>BC</span>
    <span><i class="dot" style="background:#ef4444"></i>Parks Canada</span>
    <span><i class="dot" style="background:#cbd5e1"></i>front · <i class="dia" style="background:#cbd5e1"></i>backcountry</span>
  </div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
(async () => {
  const COLOR = { "Alberta Parks":"#f59e0b", "BC Parks":"#22c55e", "Parks Canada":"#ef4444" };
  const esc = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const map = L.map("map", { zoomControl:true }).setView([54.5,-119], 5);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { maxZoom:19, attribution:'&copy; OpenStreetMap &copy; CARTO' }).addTo(map);

  function icon(p) {
    const c = COLOR[p.j] || "#64748b";
    const back = p.t === "backcountry";
    const cls = "pin" + (back ? " bc-shape" : "");
    const size = back ? 12 : 13;
    const style = \`width:\${size}px;height:\${size}px;background:\${c};border:1.5px solid #0b0f14;\${back?"":"border-radius:50%;"}\`;
    return L.divIcon({ className:"", html:\`<div class="\${cls}" style="\${style}"></div>\`,
      iconSize:[size,size], iconAnchor:[size/2,size/2], popupAnchor:[0,-size/2] });
  }

  function popupHtml(p, info) {
    const ll = p.lat.toFixed(5) + ", " + p.lng.toFixed(5);
    const desc = info === undefined
      ? '<div class="desc muted">Loading details…</div>'
      : (info && info.description ? \`<div class="desc">\${esc(info.description)}</div>\` : '<div class="desc muted">No description.</div>');
    return \`<b>\${esc(p.name)}</b><br><span class="tag">\${esc(p.j)}\${p.t==="backcountry"?" · backcountry":""}</span>\` +
      \`<div class="ll"><span>\${ll}</span><button onclick="navigator.clipboard&&navigator.clipboard.writeText('\${ll}').then(()=>{this.textContent='copied'})">copy</button></div>\` +
      \`<a class="book" href="\${esc(p.url)}" target="_blank" rel="noopener">Book / check availability →</a>\` + desc;
  }

  try {
    const r = await fetch("/api/campgrounds"); if (!r.ok) throw new Error("map data unavailable");
    const d = await r.json();
    const group = [];
    for (const p of d.pins) {
      const m = L.marker([p.lat, p.lng], { icon: icon(p) }).bindPopup(popupHtml(p));
      m.on("popupopen", async () => {
        if (m._loaded) return; m._loaded = true;
        try {
          const ir = await fetch("/api/campground?id=" + encodeURIComponent(p.id));
          const info = ir.ok ? await ir.json() : null;
          m.setPopupContent(popupHtml(p, info));
        } catch { m.setPopupContent(popupHtml(p, null)); }
      });
      m.addTo(map); group.push(m);
    }
    document.getElementById("sub").textContent =
      d.pins.length.toLocaleString() + " of " + d.total.toLocaleString() + " campgrounds mapped";
    if (group.length) map.fitBounds(L.featureGroup(group).getBounds().pad(0.05));
  } catch (e) {
    document.getElementById("sub").textContent = "Map data unavailable — " + (e.message || e);
  }
})();
</script>
</body>
</html>`;
