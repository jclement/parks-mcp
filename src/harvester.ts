/**
 * Background availability harvester. Slowly refreshes a rolling 90-day availability
 * window for every campground into the harvest store, so the map and tools serve
 * instant cached lookups. Politeness: one campground at a time, jittered spacing,
 * Camis (BC/Parks Canada) refreshed every few hours, Alberta once a day. Also warms
 * the campground-info cache so popups load instantly.
 */
import { campgroundInfo, listCampgrounds, rawAvailability } from "./providers/registry.ts";
import { HARVEST_DAYS, harvestEnabled, lastHarvest, storeError, storeHarvest } from "./harvest.ts";

const CAMIS_INTERVAL = (Number(process.env.HARVEST_CAMIS_HOURS) || 4) * 3600 * 1000; // default 4h
const ALBERTA_INTERVAL = (Number(process.env.HARVEST_ALBERTA_HOURS) || 24) * 3600 * 1000; // 24h
const SPACING_MS = (Number(process.env.HARVEST_SPACING_SECONDS) || 15) * 1000;

const today = () => new Date().toISOString().slice(0, 10);
const isAlberta = (id: string) => id.startsWith("ab");
const interval = (id: string) => (isAlberta(id) ? ALBERTA_INTERVAL : CAMIS_INTERVAL);

let parkIds: string[] = [];

/** Epoch ms at which a park becomes due (0 = due now: never harvested or window rolled). */
function dueAt(parkId: string, windowStart: string): number {
  const { updated, windowStart: ws } = lastHarvest(parkId);
  if (!updated || ws !== windowStart) return 0;
  return updated + interval(parkId);
}

async function harvestOne(parkId: string, windowStart: string): Promise<void> {
  try {
    const r = await rawAvailability(parkId, windowStart, HARVEST_DAYS);
    storeHarvest(parkId, windowStart, r.jurisdiction, r.bookingUrl, r.sites);
  } catch (e) {
    storeError(parkId, (e as Error).message);
  }
  // Warm the description/info cache so popups don't fetch live (best-effort).
  try {
    await campgroundInfo(parkId);
  } catch {
    /* ignore */
  }
}

async function tick(): Promise<void> {
  try {
    if (parkIds.length === 0) parkIds = (await listCampgrounds()).map((c) => c.parkId);
    const windowStart = today();
    const now = Date.now();
    // Pick the most-overdue due park; tie-break Camis (cheap) before Alberta.
    let pick: string | null = null;
    let pickDue = Infinity;
    let pickAb = true;
    for (const id of parkIds) {
      const due = dueAt(id, windowStart);
      if (due > now) continue;
      const ab = isAlberta(id);
      if (due < pickDue || (due === pickDue && pickAb && !ab)) {
        pick = id;
        pickDue = due;
        pickAb = ab;
      }
    }
    if (pick) await harvestOne(pick, windowStart);
  } catch (e) {
    console.warn("harvester tick error:", (e as Error).message);
  }
  scheduleNext();
}

function scheduleNext(): void {
  const jitter = 0.75 + Math.random() * 0.5; // ±25%
  const t = setTimeout(tick, Math.round(SPACING_MS * jitter));
  if (typeof t === "object" && "unref" in t) t.unref();
}

export function startHarvester(): void {
  if (!harvestEnabled()) {
    console.log("harvester: disabled (no CACHE_DIR / SQLite)");
    return;
  }
  console.log(
    `harvester: on (Camis every ${Math.round(CAMIS_INTERVAL / 3.6e6)}h, Alberta every ${Math.round(ALBERTA_INTERVAL / 3.6e6)}h, 1 park / ~${SPACING_MS / 1000}s)`,
  );
  setTimeout(tick, 2000); // small delay after boot
}
