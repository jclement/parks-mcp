// Live ops dashboard at /dashboard — harvest progress, freshness, failures, DB
// sizes, and MCP activity. Polls /api/dashboard. No secrets; read-only stats.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>Camp, Eh? · Ops</title>
<style>
  :root{--bg:#0a0e14;--card:#111927;--line:#1f2a3a;--ink:#e8eef5;--muted:#8aa0b8;--ab:#f59e0b;--bc:#22c55e;--pc:#ef4444;--sk:#38bdf8;--accent:#7c3aed}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:22px 16px 60px}
  header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:18px}
  header h1{margin:0;font-size:22px;letter-spacing:-.01em}
  header img{width:24px;height:24px;vertical-align:-5px;margin-right:4px}
  header .upd{color:var(--muted);font-size:12.5px;margin-left:auto}
  header a{color:#a78bfa;font-size:13px;text-decoration:none}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .card .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
  .card .v{font-size:28px;font-weight:800;margin-top:5px;line-height:1}
  .card .v small{font-size:13px;color:var(--muted);font-weight:600}
  .grid2{display:grid;grid-template-columns:1.1fr 1fr;gap:14px;margin-bottom:16px}
  @media(max-width:760px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .panel h2{margin:0 0 12px;font-size:14px;color:#cbd5e1;display:flex;justify-content:space-between;align-items:center}
  .panel h2 .pill{font-size:11px;color:var(--muted);font-weight:500}
  .bar{height:10px;border-radius:6px;background:#0a0e14;overflow:hidden;display:flex;margin:4px 0 2px}
  .bar i{display:block;height:100%}
  .srcrow{display:flex;align-items:center;gap:10px;font-size:13px;padding:7px 0;border-top:1px solid var(--line)}
  .srcrow:first-child{border-top:0}
  .srcrow .nm{display:flex;align-items:center;gap:7px;min-width:120px}
  .srcrow .dot{width:9px;height:9px;border-radius:50%}
  .srcrow .pct{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--muted);font-weight:600;padding:5px 8px;border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  td{padding:5px 8px;border-bottom:1px solid #16202e;font-variant-numeric:tabular-nums}
  td.err{color:#fca5a5}
  .ok{color:#4ade80}.bad{color:#f87171}
  .mono{font-family:ui-monospace,monospace;font-size:11.5px;color:#cbd5e1}
  .live{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 #22c55e99;animation:p 1.6s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 #22c55e88}70%{box-shadow:0 0 0 7px #22c55e00}100%{box-shadow:0 0 0 0 #22c55e00}}
  .empty{color:var(--muted);font-size:13px;padding:10px 2px}
  .mcpbar{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:6px 0}
  .mcpbar .lbl{width:130px;color:#cbd5e1}.mcpbar .track{flex:1;height:9px;background:#0a0e14;border-radius:5px;overflow:hidden}
  .mcpbar .track i{display:block;height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa)}
  .mcpbar .n{width:42px;text-align:right;color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><img src="/favicon.svg" alt="">Camp, Eh? <span style="color:var(--muted);font-weight:500">Ops</span></h1>
    <span class="upd"><span class="live"></span> <span id="upd">connecting…</span> · <a href="/">map →</a></span>
  </header>
  <div class="cards" id="cards"></div>
  <div class="grid2">
    <div class="panel"><h2>Harvest progress <span class="pill" id="winpill"></span></h2><div id="progress"></div></div>
    <div class="panel"><h2>MCP activity <span class="pill" id="mcptotal"></span></h2><div id="mcp"></div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>Recent harvests <span class="pill" id="curpill"></span></h2><div id="recent"></div></div>
    <div class="panel"><h2>Failures <span class="pill" id="errpill"></span></h2><div id="errors"></div></div>
  </div>
  <div class="panel"><h2>Storage &amp; window</h2><div id="storage"></div></div>
</div>
<script>
const SRC={"Alberta Parks":"#f59e0b","BC Parks":"#22c55e","Parks Canada":"#ef4444","Saskatchewan Parks":"#38bdf8"};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const kb=n=>n>=1048576?(n/1048576).toFixed(1)+" MB":(n/1024).toFixed(0)+" KB";
const ago=t=>{if(!t)return"never";const s=(Date.now()-t)/1000;if(s<90)return Math.round(s)+"s";if(s<5400)return Math.round(s/60)+"m";if(s<129600)return Math.round(s/3600)+"h";return Math.round(s/86400)+"d";};
const card=(k,v,sub)=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+(sub?' <small>'+sub+'</small>':'')+'</div></div>';

async function tick(){
  let d; try{ d=await (await fetch("/api/dashboard")).json(); }catch(e){ document.getElementById("upd").textContent="offline"; return; }
  document.getElementById("upd").textContent="updated "+new Date().toLocaleTimeString();
  const harvested=d.status.harvested, total=d.totalParks, pct=total?Math.round(harvested/total*100):0;
  const dbTotal=Object.values(d.db||{}).reduce((a,b)=>a+b,0);
  document.getElementById("cards").innerHTML=[
    card("Campgrounds", total),
    card("Harvested", harvested, pct+"%"),
    card("Failures", d.status.errors, d.status.errors?"⚠":"ok"),
    card("MCP calls", d.mcp.total),
    card("Cache size", kb(dbTotal)),
    card("Window", (d.window.windowDays||90)+"d"),
  ].join("");
  document.getElementById("winpill").textContent="from "+d.window.today+" · "+pct+"% cached";

  // progress by source
  const tj=d.totalByJurisdiction||{}, bj=d.bySource||{};
  document.getElementById("progress").innerHTML=Object.keys(tj).sort().map(j=>{
    const have=(bj[j]||{}).harvested||0, tot=tj[j], p=tot?Math.round(have/tot*100):0, col=SRC[j]||"#64748b";
    return '<div class="srcrow"><div class="nm"><span class="dot" style="background:'+col+'"></span>'+esc(j)+'</div>'+
      '<div class="bar" style="flex:1"><i style="width:'+p+'%;background:'+col+'"></i></div>'+
      '<span class="pct">'+have+'/'+tot+' · '+((bj[j]||{}).sites||0).toLocaleString()+' sites · '+ago((bj[j]||{}).newest)+'</span></div>';
  }).join("")||'<div class="empty">No harvest yet.</div>';

  // mcp activity
  document.getElementById("mcptotal").textContent=d.mcp.total+" calls";
  const calls=Object.entries(d.mcp.calls).sort((a,b)=>b[1]-a[1]); const max=Math.max(1,...calls.map(c=>c[1]));
  document.getElementById("mcp").innerHTML=(calls.map(([k,v])=>'<div class="mcpbar"><span class="lbl">'+esc(k)+'</span><span class="track"><i style="width:'+(v/max*100)+'%"></i></span><span class="n">'+v+'</span></div>').join("")||'<div class="empty">No MCP calls yet.</div>');

  // recent harvests + currently
  const cur=d.harvest.current;
  document.getElementById("curpill").innerHTML=cur?('<span class="live"></span> '+esc(cur.parkId.split(":")[0])+'…'):'idle';
  const rec=d.harvest.recent||[];
  document.getElementById("recent").innerHTML=rec.length?'<table><tr><th>park</th><th>sites</th><th>took</th><th>when</th></tr>'+
    rec.slice(0,10).map(r=>'<tr><td class="mono">'+esc(r.parkId)+'</td><td>'+(r.ok?r.sites:'<span class="bad">fail</span>')+'</td><td>'+(r.ms>1000?(r.ms/1000).toFixed(1)+'s':r.ms+'ms')+'</td><td>'+ago(r.at)+'</td></tr>').join("")+'</table>':'<div class="empty">Nothing harvested this session.</div>';

  // failures
  const errs=d.errors||[];
  document.getElementById("errpill").textContent=errs.length?errs.length+" parks":"none";
  document.getElementById("errors").innerHTML=errs.length?'<table><tr><th>park</th><th>error</th><th>when</th></tr>'+
    errs.slice(0,12).map(e=>'<tr><td class="mono">'+esc(e.parkId)+'</td><td class="err">'+esc((e.error||"").slice(0,60))+'</td><td>'+ago(e.updated)+'</td></tr>').join("")+'</table>':'<div class="empty ok">No failures. 🎉</div>';

  // storage
  const dbrows=Object.entries(d.db||{}).map(([f,s])=>'<tr><td class="mono">'+esc(f)+'</td><td>'+kb(s)+'</td></tr>').join("");
  document.getElementById("storage").innerHTML='<table><tr><th>file</th><th>size</th></tr>'+(dbrows||'<tr><td colspan=2 class="empty">no cache dir</td></tr>')+'</table>'+
    '<p style="color:var(--muted);font-size:12.5px;margin:10px 0 0">Adaptive refresh: parks near capacity every few hours, wide-open ones up to ~daily, over a '+(d.refresh?d.refresh.windowDays:90)+'-day window (Aspira first pass '+(d.refresh?d.refresh.phase1Days:30)+'d). Lanes: Camis ~'+(d.refresh?d.refresh.camisLaneSeconds:6)+'s, Aspira ~'+(d.refresh?d.refresh.aspiraLaneSeconds:12)+'s.</p>';
}
tick(); setInterval(tick, 5000);
</script>
</body>
</html>`;
