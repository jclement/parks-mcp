import { cached, ttlMs } from "../parks/cache.ts";
import { albertaProvider } from "../parks/service.ts";
import { bcParksProvider, parksCanadaProvider } from "./camis.ts";
import COORDS from "../data/coords.json";
import type {
  AvailabilityWithMeta,
  CampgroundInfo,
  CampgroundListItem,
  Provider,
  VacancyResult,
} from "./types.ts";

// Baked geocoded fallback coordinates (BC/Parks Canada don't publish any; Alberta
// only exposes them per-park). Keyed by provider-prefixed parkId; API coords win.
const COORD_TABLE = COORDS as Record<string, number[]>;
function withCoords<T extends { parkId: string; lat?: number; lng?: number }>(item: T): T {
  if (item.lat != null && item.lng != null) return item;
  const c = COORD_TABLE[item.parkId];
  return c && c.length === 2 ? { ...item, lat: c[0], lng: c[1] } : item;
}

const PROVIDERS: Provider[] = [albertaProvider, bcParksProvider, parksCanadaProvider];
const byPrefix = new Map(PROVIDERS.map((p) => [p.prefix, p]));

// Metadata barely changes; availability changes often.
const METADATA_TTL = ttlMs("CAMPGROUND_CACHE_TTL", 7 * 24 * 60 * 60); // 7 days
const AVAILABILITY_TTL = ttlMs("AVAILABILITY_CACHE_TTL", 5 * 60); // 5 minutes

function route(parkId: string): { provider: Provider; localId: string } {
  const idx = parkId.indexOf(":");
  const prefix = idx >= 0 ? parkId.slice(0, idx) : "";
  const provider = byPrefix.get(prefix);
  if (!provider) throw new Error(`Unknown park system for id "${parkId}"`);
  return { provider, localId: parkId.slice(idx + 1) };
}

/** Aggregate every park system's campgrounds, ids prefixed by provider. */
export function listCampgrounds(): Promise<CampgroundListItem[]> {
  return Promise.allSettled(
    PROVIDERS.map((p) =>
      // Cache each provider's list independently so one slow/down system doesn't
      // block or evict the others.
      cached(`list:${p.prefix}`, METADATA_TTL, async () =>
        (await p.list()).map((item) => ({ ...item, parkId: `${p.prefix}:${item.parkId}` })),
      ),
    ),
  ).then((results) => {
    const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map(withCoords);
    return all.sort(
      (a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.name.localeCompare(b.name),
    );
  });
}

export function getAvailability(
  parkId: string,
  startISO: string,
  nights: number,
): Promise<AvailabilityWithMeta> {
  return cached(`avail:${parkId}:${startISO}:${nights}`, AVAILABILITY_TTL, async () => {
    const { provider, localId } = route(parkId);
    const r = await provider.availability(localId, startISO, nights);
    return { ...r, parkId };
  });
}

export function findVacancies(
  parkId: string,
  startISO: string,
  endISO: string,
  nights: number,
): Promise<VacancyResult> {
  return cached(`vac:${parkId}:${startISO}:${endISO}:${nights}`, AVAILABILITY_TTL, async () => {
    const { provider, localId } = route(parkId);
    const r = await provider.vacancies(localId, startISO, endISO, nights);
    return { ...r, parkId };
  });
}

export function campgroundInfo(parkId: string): Promise<CampgroundInfo> {
  return cached(`info:${parkId}`, METADATA_TTL, async () => {
    const { provider, localId } = route(parkId);
    const r = await provider.info(localId);
    return withCoords({ ...r, parkId });
  });
}
