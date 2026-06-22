/**
 * Data-integrity check: sample random campgrounds + random dates and compare our cached
 * availability against a fresh live fetch from the upstream reservation site. A faithful
 * cache matches the live grid; small deltas are just cancellation churn since the last
 * harvest, so we flag only divergences beyond a tolerance.
 *
 * Must run where upstream is reachable (the deploy host / container — Aspira's Queue-it
 * blocks datacenter IPs). Examples:
 *   bun run scripts/integrity-check.ts                 # 50 parks, 1 date each
 *   bun run scripts/integrity-check.ts --parks 30 --dates 2
 *   bun run scripts/integrity-check.ts --seed 7        # reproducible sample
 */
import { harvestTargets, rawAvailability } from "../src/providers/registry.ts";
import { getCachedAvailability, lastHarvest, HARVEST_DAYS } from "../src/harvest.ts";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const N_PARKS = arg("parks", 50);
const N_DATES = arg("dates", 1);
let seed = arg("seed", Math.floor((Date.now() % 1e9))); // vary by default; pass --seed for repeatable
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
};
/** Sites with every night of [start, start+nights) available. */
function countStay(sites: { available: string[] }[], start: string, nights: number): number {
  let c = 0;
  for (const s of sites) {
    let ok = true;
    for (let n = 0; n < nights; n++) if (!s.available.includes(addDays(start, n))) { ok = false; break; }
    if (ok) c++;
  }
  return c;
}

const today = iso(new Date());
// Only sample parks we've actually harvested (so there's something to compare).
const all = (await harvestTargets()).map((p) => p.parkId).filter((id) => lastHarvest(id).updated);
// Shuffle (seeded) and take N.
for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
const sample = all.slice(0, Math.min(N_PARKS, all.length));
console.log(`integrity-check: ${sample.length} parks × ${N_DATES} date(s), seed=${seed & 0x7fffffff}\n`);

let checks = 0, ok = 0, mism = 0, errs = 0;
const problems: string[] = [];
for (const id of sample) {
  const m = lastHarvest(id);
  const windowDays = m.windowDays || HARVEST_DAYS;
  for (let d = 0; d < N_DATES; d++) {
    const nights = 1 + Math.floor(rand() * 3); // 1–3 nights
    const offset = 2 + Math.floor(rand() * Math.max(1, windowDays - nights - 2));
    const date = addDays(today, offset);
    try {
      const cached = getCachedAvailability(id, date, Math.max(nights, 14));
      const live = await rawAvailability(id, date, nights);
      const cN = cached ? countStay(cached.sites, date, nights) : null;
      const lN = countStay(live.sites, date, nights);
      checks++;
      if (cN === null) { problems.push(`  ? ${id} ${date} ${nights}n — no cache for window`); continue; }
      const tol = Math.max(2, Math.ceil(lN * 0.1)); // allow churn since last harvest
      if (Math.abs(lN - cN) <= tol) ok++;
      else {
        mism++;
        const ageH = ((Date.now() - m.updated) / 3.6e6).toFixed(0);
        problems.push(`  ✗ ${id} ${date} ${nights}n — cached ${cN} vs live ${lN} (Δ${lN - cN}, age ${ageH}h)`);
      }
    } catch (e) {
      errs++;
      problems.push(`  ! ${id} ${date} — ${(e as Error).message}`);
    }
  }
}

console.log(problems.join("\n") || "  (no issues)");
console.log(`\n${ok}/${checks} within tolerance · ${mism} mismatch · ${errs} error`);
console.log(mism === 0 && errs === 0 ? "PASS — cache is faithful to live." : "REVIEW the divergences above.");
process.exit(mism === 0 && errs === 0 ? 0 : 1);
