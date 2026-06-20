/**
 * Background availability harvester. Slowly refreshes a rolling 90-day availability
 * window for every campground into the harvest store, so the map and tools serve
 * instant cached lookups. Politeness: one campground at a time, jittered spacing,
 * Camis (BC/Parks Canada) refreshed every few hours, Alberta once a day. Also warms
 * the campground-info cache so popups load instantly.
 */
import { campgroundInfo, listCampgrounds, rawAvailability } from "./providers/registry.ts";
import { HARVEST_DAYS, harvestEnabled, lastHarvest, storeError, storeHarvest } from "./harvest.ts";
import { harvestDone, harvestStart } from "./stats.ts";

const CAMIS_INTERVAL = (Number(process.env.HARVEST_CAMIS_HOURS) || 4) * 3600 * 1000; // BC + Parks Canada
const ALBERTA_INTERVAL = (Number(process.env.HARVEST_ALBERTA_HOURS) || 24) * 3600 * 1000; // Aspira (AB, SK)

// Two independent lanes so a slow Aspira park can't starve the cheap Camis ones.
// Camis (BC/PC) is one fast call per park; Aspira (AB/SK) paginates and is slow.
const LANES = {
  camis: { prefixes: ["bc", "pc"], spacing: (Number(process.env.HARVEST_CAMIS_SPACING_SECONDS) || 6) * 1000 },
  aspira: { prefixes: ["ab", "sk"], spacing: (Number(process.env.HARVEST_ASPIRA_SPACING_SECONDS) || 12) * 1000 },
};
type Lane = keyof typeof LANES;

const isAspira = (id: string) => id.startsWith("ab") || id.startsWith("sk");
const interval = (id: string) => (isAspira(id) ? ALBERTA_INTERVAL : CAMIS_INTERVAL);

// Aspira (AB/SK) is slow, so harvest a short window first — real data for every park
// fast — then expand to the full window once that quick pass is done.
const ASPIRA_PHASE1_DAYS = Number(process.env.HARVEST_ASPIRA_PHASE1_DAYS) || 30;
let aspiraTarget = ASPIRA_PHASE1_DAYS;
const targetDays = (id: string) => (isAspira(id) ? aspiraTarget : HARVEST_DAYS);

const today = () => new Date().toISOString().slice(0, 10);
let parkIds: string[] = [];
const rr: Record<Lane, number> = { camis: 0, aspira: 0 };

/** Epoch ms at which a park becomes due (0 = due now: never harvested, window rolled,
 * or its harvested window is shorter than the current target). */
function dueAt(parkId: string, windowStart: string): number {
  const { updated, windowStart: ws, windowDays } = lastHarvest(parkId);
  if (!updated || ws !== windowStart || windowDays < targetDays(parkId)) return 0;
  return updated + interval(parkId);
}

/** Once every Aspira park has the phase-1 window for today, expand to the full window. */
function maybeAdvancePhase(windowStart: string): void {
  if (aspiraTarget >= HARVEST_DAYS) return;
  const aspira = parkIds.filter(isAspira);
  if (!aspira.length) return;
  const allDone = aspira.every((id) => {
    const m = lastHarvest(id);
    return m.updated && m.windowStart === windowStart && m.windowDays >= ASPIRA_PHASE1_DAYS;
  });
  if (allDone) {
    aspiraTarget = HARVEST_DAYS;
    console.log(`harvester: Aspira phase-1 (${ASPIRA_PHASE1_DAYS}d) complete — expanding to ${HARVEST_DAYS}d`);
  }
}

async function harvestOne(parkId: string, windowStart: string, days: number): Promise<void> {
  harvestStart(parkId);
  const t = Date.now();
  let ok = true;
  let sites = 0;
  let error: string | undefined;
  try {
    const r = await rawAvailability(parkId, windowStart, days);
    sites = r.sites.length;
    storeHarvest(parkId, windowStart, days, r.jurisdiction, r.bookingUrl, r.sites);
  } catch (e) {
    ok = false;
    error = (e as Error).message;
    storeError(parkId, error);
  }
  // Warm the description/info cache so popups don't fetch live (best-effort).
  try {
    await campgroundInfo(parkId);
  } catch {
    /* ignore */
  }
  harvestDone(parkId, ok, sites, Date.now() - t, error);
}

async function laneTick(lane: Lane): Promise<void> {
  try {
    if (parkIds.length === 0) parkIds = (await listCampgrounds()).map((c) => c.parkId);
    const { prefixes } = LANES[lane];
    const windowStart = today();
    const now = Date.now();
    if (lane === "aspira") maybeAdvancePhase(windowStart);
    // Round-robin within the lane's provinces (pick oldest-due of the next one).
    let pick: string | null = null;
    for (let k = 0; k < prefixes.length; k++) {
      const pre = prefixes[(rr[lane] + k) % prefixes.length];
      let best: string | null = null;
      let bestDue = Infinity;
      for (const id of parkIds) {
        if (!id.startsWith(pre)) continue;
        const due = dueAt(id, windowStart);
        if (due <= now && due < bestDue) {
          bestDue = due;
          best = id;
        }
      }
      if (best) {
        pick = best;
        rr[lane] = (rr[lane] + k + 1) % prefixes.length;
        break;
      }
    }
    if (pick) await harvestOne(pick, windowStart, targetDays(pick));
  } catch (e) {
    console.warn(`harvester ${lane} error:`, (e as Error).message);
  }
  schedule(lane);
}

function schedule(lane: Lane): void {
  const jitter = 0.75 + Math.random() * 0.5; // ±25%
  const t = setTimeout(() => laneTick(lane), Math.round(LANES[lane].spacing * jitter));
  if (typeof t === "object" && "unref" in t) t.unref();
}

export function startHarvester(): void {
  if (!harvestEnabled()) {
    console.log("harvester: disabled (no CACHE_DIR / SQLite)");
    return;
  }
  console.log(
    `harvester: 2 lanes — camis(BC/PC) ~${LANES.camis.spacing / 1000}s, aspira(AB/SK) ~${LANES.aspira.spacing / 1000}s; ` +
      `refresh camis ${Math.round(CAMIS_INTERVAL / 3.6e6)}h, aspira ${Math.round(ALBERTA_INTERVAL / 3.6e6)}h`,
  );
  setTimeout(() => laneTick("camis"), 1500);
  setTimeout(() => laneTick("aspira"), 3000);
}
