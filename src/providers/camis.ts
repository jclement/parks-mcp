import { addDaysISO, computeVacancies } from "../parks/service.ts";
import { cleanText } from "../parks/parse.ts";
import type {
  AvailabilityResult,
  AvailabilityWithMeta,
  CampgroundInfo,
  CampgroundListItem,
  Provider,
  SiteAvailability,
  VacancyResult,
} from "./types.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
// Parks Canada's Camis tenant mixes in non-camping reservations (shuttles, buses,
// guided hikes, day-use, fishing, parking) — exclude those from the campground list.
const NON_CAMPING = /\b(shuttle|bus|guided hikes?|guided tours?|day[- ]?use|fishing|parking|interpretive|orientation)\b/i;
const DEFAULT_SPAN = 14;
const MAX_NESTED_MAPS = 25;

/**
 * Camis / "GoingToCamp" platform — BC Parks and Parks Canada run identical tenants
 * on different hosts. It's a clean anonymous JSON API: `/api/resourceLocation` lists
 * campgrounds; `/api/availability/map` returns per-site daily availability where a
 * day's `availability === 0` means bookable (per the camply reference implementation).
 * Local id is "<resourceLocationId>_<rootMapId>".
 */
class CamisProvider implements Provider {
  constructor(
    public prefix: string,
    public jurisdiction: string,
    private host: string,
  ) {}

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`https://${this.host}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${this.jurisdiction} API ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private bookingUrl(rlId: string, mapId: string): string {
    return `https://${this.host}/create-booking/results?resourceLocationId=${rlId}&mapId=${mapId}&searchTabGroupId=0&bookingCategoryId=0`;
  }

  private async resourceLocations(): Promise<RawResourceLocation[]> {
    return this.api<RawResourceLocation[]>("/api/resourceLocation");
  }

  async list(): Promise<CampgroundListItem[]> {
    const locations = await this.resourceLocations();
    return locations
      .filter((r) => !NON_CAMPING.test(localName(r.localizedValues)))
      .map((r) => {
      const { lat, lng } = parseGps(r.gpsCoordinates);
      const mapId = String(r.rootMapId);
      const rlId = String(r.resourceLocationId);
      return {
        parkId: `${rlId}_${mapId}`,
        name: localName(r.localizedValues) || rlId,
        jurisdiction: this.jurisdiction,
        type: "campground",
        region: r.region || undefined,
        siteTypes: [],
        lat,
        lng,
        bookingUrl: this.bookingUrl(rlId, mapId),
      };
    });
  }

  async availability(localId: string, startISO: string, nights: number): Promise<AvailabilityWithMeta> {
    const { rlId, mapId } = splitId(localId);
    const span = Math.max(nights, DEFAULT_SPAN);
    const res = await this.fetchAvailability(rlId, mapId, startISO, addDaysISO(startISO, span));
    return { ...res, parkId: localId, jurisdiction: this.jurisdiction, bookingUrl: this.bookingUrl(rlId, mapId) };
  }

  async vacancies(
    localId: string,
    startISO: string,
    endISO: string,
    nights: number,
  ): Promise<VacancyResult> {
    const { rlId, mapId } = splitId(localId);
    const res = await this.fetchAvailability(rlId, mapId, startISO, addDaysISO(endISO, nights));
    const vacancies = computeVacancies(res.sites, startISO, endISO, nights);
    return { parkId: localId, jurisdiction: this.jurisdiction, bookingUrl: this.bookingUrl(rlId, mapId), vacancies };
  }

  async info(localId: string): Promise<CampgroundInfo> {
    const { rlId, mapId } = splitId(localId);
    const match = (await this.resourceLocations()).find((r) => String(r.resourceLocationId) === rlId);
    const { lat, lng } = parseGps(match?.gpsCoordinates);
    return {
      parkId: localId,
      name: localName(match?.localizedValues) || rlId,
      jurisdiction: this.jurisdiction,
      description: localDescription(match?.localizedValues),
      lat,
      lng,
      bookingUrl: this.bookingUrl(rlId, mapId),
    };
  }

  /** Pull per-site daily availability for [startISO, endISO), following nested maps. */
  private async fetchAvailability(
    rlId: string,
    mapId: string,
    startISO: string,
    endISO: string,
  ): Promise<AvailabilityResult> {
    const days = daysBetween(startISO, endISO);
    const dates = Array.from({ length: days }, (_, i) => addDaysISO(startISO, i));
    const bySite = new Map<string, SiteAvailability>();
    const visited = new Set<string>();
    const queue = [mapId];

    while (queue.length && visited.size < MAX_NESTED_MAPS) {
      const mid = queue.shift()!;
      if (visited.has(mid)) continue;
      visited.add(mid);

      const q =
        `/api/availability/map?mapId=${mid}&resourceLocationId=${rlId}&bookingCategoryId=0` +
        `&startDate=${startISO}&endDate=${endISO}&getDailyAvailability=true&partySize=1&numEquipment=1`;
      let data: RawAvailability;
      try {
        data = await this.api<RawAvailability>(q);
      } catch {
        continue;
      }

      for (const { siteId, available } of sitesFromAvailability(data.resourceAvailabilities, dates)) {
        const existing = bySite.get(siteId);
        if (existing) {
          existing.available = [...new Set([...existing.available, ...available])].sort();
        } else {
          bySite.set(siteId, { siteId, label: siteLabel(siteId), available });
        }
      }
      for (const nested of Object.keys(data.mapLinkAvailabilities ?? {})) {
        if (!visited.has(nested)) queue.push(nested);
      }
    }

    return { windowStart: startISO, windowDays: days, dates, sites: [...bySite.values()] };
  }
}

export const bcParksProvider = new CamisProvider("bc", "BC Parks", "camping.bcparks.ca");
export const parksCanadaProvider = new CamisProvider("pc", "Parks Canada", "reservation.pc.gc.ca");

/* ----- raw API shapes + helpers ----- */

interface RawLocalized {
  cultureName?: string;
  fullName?: string;
  name?: string;
  title?: string;
  description?: string;
}
interface RawResourceLocation {
  resourceLocationId: number;
  rootMapId: number;
  region?: string;
  gpsCoordinates?: unknown;
  localizedValues?: RawLocalized[];
}
interface RawAvailability {
  resourceAvailabilities?: Record<string, { availability: number }[]>;
  mapLinkAvailabilities?: Record<string, unknown>;
}

/**
 * Map Camis per-day availability to available ISO dates per site. A day is bookable
 * iff `availability === 0` (per the camply GoingToCamp reference); the daily array
 * is index-aligned to `dates`.
 */
export function sitesFromAvailability(
  resourceAvailabilities: Record<string, { availability: number }[]> | undefined,
  dates: string[],
): { siteId: string; available: string[] }[] {
  return Object.entries(resourceAvailabilities ?? {}).map(([siteId, daily]) => ({
    siteId,
    available: daily
      .map((d, i) => (d?.availability === 0 ? dates[i] : null))
      .filter((d): d is string => d != null),
  }));
}

function splitId(localId: string): { rlId: string; mapId: string } {
  const us = localId.lastIndexOf("_");
  return { rlId: localId.slice(0, us), mapId: localId.slice(us + 1) };
}

function localName(lv?: RawLocalized[]): string {
  const v = lv?.find((x) => x.cultureName?.startsWith("en")) ?? lv?.[0];
  return (v?.fullName || v?.name || v?.title || "").trim();
}
function localDescription(lv?: RawLocalized[]): string | undefined {
  const v = lv?.find((x) => x.cultureName?.startsWith("en")) ?? lv?.[0];
  return cleanText(v?.description);
}

function siteLabel(siteId: string): string {
  return `Site ${siteId.replace(/^-/, "")}`;
}

function parseGps(gps: unknown): { lat?: number; lng?: number } {
  if (!gps) return {};
  if (typeof gps === "object") {
    const o = gps as Record<string, unknown>;
    const lat = Number(o.latitude ?? o.lat);
    const lng = Number(o.longitude ?? o.lng ?? o.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) return { lat, lng };
    return {};
  }
  if (typeof gps === "string" && gps.includes(",")) {
    const [a, b] = gps.split(",").map((s) => Number(s.trim()));
    if (Number.isFinite(a) && Number.isFinite(b) && (a || b)) return { lat: a, lng: b };
  }
  return {};
}

function daysBetween(startISO: string, endISO: string): number {
  const [y1, m1, d1] = startISO.split("-").map(Number);
  const [y2, m2, d2] = endISO.split("-").map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.max(0, Math.round((b - a) / 86400000));
}
