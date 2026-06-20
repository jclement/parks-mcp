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

export interface SearchParams {
  query?: string;
  jurisdiction?: string;
  /** Center for a radius search: explicit coords, or a place name (geocoded). */
  lat?: number;
  lng?: number;
  near?: string;
  radiusKm?: number;
  limit?: number;
}

export interface SearchHit extends CampgroundListItem {
  distanceKm?: number;
}

/** Find campgrounds by name/region/jurisdiction and/or within a radius of a point. */
export async function searchCampgrounds(p: SearchParams): Promise<SearchHit[]> {
  const all = await listCampgrounds();
  const q = p.query?.trim().toLowerCase();
  const jur = p.jurisdiction?.trim().toLowerCase();

  let center: { lat: number; lng: number } | null = null;
  if (p.lat != null && p.lng != null) center = { lat: p.lat, lng: p.lng };
  else if (p.near) center = await geocode(p.near);
  const radius = p.radiusKm ?? (center ? 50 : undefined);

  let hits: SearchHit[] = all.filter((c) => {
    if (q && !(`${c.name} ${c.region ?? ""}`.toLowerCase().includes(q))) return false;
    if (jur && !c.jurisdiction.toLowerCase().includes(jur)) return false;
    return true;
  });

  if (center) {
    hits = hits
      .map((c) =>
        c.lat != null && c.lng != null
          ? { ...c, distanceKm: haversineKm(center!.lat, center!.lng, c.lat, c.lng) }
          : { ...c, distanceKm: undefined },
      )
      .filter((c) => c.distanceKm != null && c.distanceKm <= radius!)
      .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  } else {
    hits.sort((a, b) => a.name.localeCompare(b.name));
  }

  return hits.slice(0, p.limit ?? 50);
}

/** Geocode a place name via OpenStreetMap (cached long-term). */
function geocode(place: string): Promise<{ lat: number; lng: number } | null> {
  return cached(`geocode:${place.toLowerCase()}`, METADATA_TTL, async () => {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ca&q=${encodeURIComponent(place)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "parks-mcp/1.0 (personal)", "Accept-Language": "en" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { lat: string; lon: string }[];
    return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
  });
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

export function campgroundInfo(parkId: string): Promise<CampgroundInfo> {
  return cached(`info:${parkId}`, METADATA_TTL, async () => {
    const { provider, localId } = route(parkId);
    const r = await provider.info(localId);
    return withCoords({ ...r, parkId });
  });
}
