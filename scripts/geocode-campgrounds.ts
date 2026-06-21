/**
 * One-off: place the per-campground children (Willow Rock, etc.) that currently stack
 * on their parent park's coords. For each split park, ask OSM Overpass for camp_site /
 * camp_pitch features within ~25km of the park center, then name-match each child
 * campground to the nearest matching feature. Distinct coords get baked into coords.json.
 *   bun run scripts/geocode-campgrounds.ts            # write
 *   bun run scripts/geocode-campgrounds.ts --dry      # report only
 */
import coords from "../src/data/coords.json";

const DRY = process.argv.includes("--dry");
const SRC = "https://parks.onewheelgeek.net/api/campgrounds";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const table = coords as Record<string, number[]>;

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) =>
  s.toLowerCase().replace(/\b(campground|campsite|camp|recreation area|provincial park|park)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();

interface Feat { name: string; lat: number; lng: number }
async function overpass(lat: number, lng: number): Promise<Feat[]> {
  const ql = `[out:json][timeout:60];(nwr["tourism"="camp_site"](around:25000,${lat},${lng});nwr["tourism"="camp_pitch"](around:25000,${lat},${lng}););out center tags;`;
  const res = await fetch(OVERPASS, { method: "POST", headers: { "User-Agent": "camp-eh-geocode/1.0", "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(ql) });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const j = (await res.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
  const out: Feat[] = [];
  for (const e of j.elements) {
    const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon, nm = e.tags?.name;
    if (typeof la === "number" && typeof lo === "number" && nm) out.push({ name: nm, lat: la, lng: lo });
  }
  return out;
}

const pins = (await (await fetch(SRC)).json()).pins as { id: string; name: string; lat: number; lng: number }[];
const kids = pins.filter((p) => /:cg:/.test(p.id));
const byParent = new Map<string, typeof kids>();
for (const k of kids) {
  const parent = k.id.split(":cg:")[0];
  (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(k);
}
console.log(`${kids.length} children across ${byParent.size} parks`);

let ok = 0, miss = 0;
for (const [parent, group] of byParent) {
  const center = { lat: group[0].lat, lng: group[0].lng };
  let feats: Feat[] = [];
  try { feats = await overpass(center.lat, center.lng); } catch (e) { console.log(`  ! ${parent} overpass failed: ${(e as Error).message}`); }
  await sleep(1500);
  for (const k of group) {
    const cg = decodeURIComponent(k.id.split(":cg:")[1]);
    const target = norm(cg);
    if (!target) { miss++; continue; }
    const cands = feats
      .map((f) => ({ f, n: norm(f.name), d: km(center.lat, center.lng, f.lat, f.lng) }))
      .filter((c) => c.d <= 45 && (c.n === target || c.n.includes(target) || target.includes(c.n)))
      .sort((a, b) => a.d - b.d);
    if (cands.length) {
      const f = cands[0].f;
      table[k.id] = [Number(f.lat.toFixed(5)), Number(f.lng.toFixed(5))];
      ok++;
      console.log(`  ✓ ${cg}  → ${table[k.id]}  (${cands[0].f.name})`);
    } else miss++;
  }
}
console.log(`\nplaced ${ok}, kept-on-park ${miss}`);
if (!DRY) {
  await Bun.write("src/data/coords.json", JSON.stringify(table, null, 0));
  console.log("wrote src/data/coords.json");
}
