import {
  ParksClient,
  applyPermitUrl,
  backcountryPrimeUrl,
  backcountryResultsUrl,
  bookingUrl,
  calendarUrl,
  campingPrimeUrl,
  campingResultsUrl,
  facilityDetailsUrl,
  permitBookingUrl,
  permitCalendarUrl,
} from "./client.ts";
import {
  parseAvailability,
  parseBackcountryCalendar,
  parseCampgrounds,
  parseFacilityDetails,
  type AvailabilityResult,
  type SiteAvailability,
} from "./parse.ts";
import type {
  AvailabilityWithMeta,
  CampgroundInfo,
  CampgroundListItem,
  Provider,
  Vacancy,
  VacancyResult,
} from "../providers/types.ts";

const JURISDICTION = "Alberta Parks";
const WINDOW_DAYS = 14;
// Front-country calendar shows ~10 sites/page; cap paging (biggest parks ~400 sites).
const MAX_PAGES = 60;

/* ----- Alberta backcountry local-id encoding ("permit:<areaId>:<zone>") ----- */

function permitId(areaId: string, zone: string): string {
  return `permit:${areaId}:${encodeURIComponent(zone)}`;
}
function isBackcountry(localId: string): boolean {
  return localId.startsWith("permit:");
}
function parsePermitId(localId: string): { areaId: string; zone: string } {
  const [, areaId, zone] = localId.split(":");
  return { areaId, zone: decodeURIComponent(zone ?? "") };
}
function shortAreaName(name: string): string {
  return name.replace(/\s*Backcountry Camping\s*$/i, "").trim();
}

/* ----- list ----- */

async function listCampgrounds(client: ParksClient): Promise<CampgroundListItem[]> {
  await client.get(campingPrimeUrl());
  const html = await client.get(campingResultsUrl());
  const front: CampgroundListItem[] = parseCampgrounds(html).map((c) => ({
    parkId: c.parkId,
    name: c.name,
    jurisdiction: JURISDICTION,
    type: "campground",
    siteTypes: c.siteTypes,
    bookingUrl: bookingUrl(c.parkId),
  }));
  // Backcountry is a bonus layer: never let it break the core campground list.
  const back = await enumerateBackcountry(client).catch(() => [] as CampgroundListItem[]);
  return [...front, ...back];
}

async function enumerateBackcountry(client: ParksClient): Promise<CampgroundListItem[]> {
  await client.get(backcountryPrimeUrl());
  const areasHtml = await client.get(backcountryResultsUrl());
  const areas = parseCampgrounds(areasHtml);
  const start = todayISO();

  const items: CampgroundListItem[] = [];
  for (const area of areas) {
    let zones;
    try {
      await client.get(applyPermitUrl(area.parkId));
      const cal = await client.get(permitCalendarUrl(area.parkId, start));
      zones = parseBackcountryCalendar(cal, start);
    } catch {
      continue; // skip an area that won't load rather than fail the whole list
    }
    for (const z of zones) {
      items.push({
        parkId: permitId(area.parkId, z.zone),
        name: `${z.zone} — ${shortAreaName(area.name)} (backcountry)`,
        jurisdiction: JURISDICTION,
        type: "backcountry",
        siteTypes: [],
        bookingUrl: permitBookingUrl(area.parkId),
      });
    }
  }
  return items;
}

/* ----- availability ----- */

function localBookingUrl(localId: string): string {
  return isBackcountry(localId) ? permitBookingUrl(parsePermitId(localId).areaId) : bookingUrl(localId);
}

async function getAvailability(
  client: ParksClient,
  localId: string,
  startISO: string,
  nights: number,
): Promise<AvailabilityWithMeta> {
  const windows = Math.max(1, Math.ceil(nights / WINDOW_DAYS));
  let merged: AvailabilityResult | null = null;
  for (let w = 0; w < windows; w++) {
    const start = addDaysISO(startISO, w * WINDOW_DAYS);
    const res = await fetchWindow(client, localId, start);
    merged = merged ? mergeAvailability(merged, res) : res;
  }
  return { ...merged!, parkId: localId, jurisdiction: JURISDICTION, bookingUrl: localBookingUrl(localId) };
}

async function fetchWindow(
  client: ParksClient,
  localId: string,
  startISO: string,
): Promise<AvailabilityResult> {
  return isBackcountry(localId)
    ? fetchBackcountryWindow(client, localId, startISO)
    : fetchFrontcountryWindow(client, localId, startISO);
}

async function fetchFrontcountryWindow(
  client: ParksClient,
  parkId: string,
  startISO: string,
): Promise<AvailabilityResult> {
  let merged: AvailabilityResult | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const html = await client.get(calendarUrl(parkId, startISO, page * 10));
    const res = parseAvailability(html, startISO);
    const fresh = res.sites.filter((s) => !seen.has(s.siteId));
    if (fresh.length === 0) break; // wrapped / exhausted
    fresh.forEach((s) => seen.add(s.siteId));
    merged = merged ? mergeAvailability(merged, res) : res;
  }
  return merged ?? emptyWindow(startISO);
}

async function fetchBackcountryWindow(
  client: ParksClient,
  localId: string,
  startISO: string,
): Promise<AvailabilityResult> {
  const { areaId, zone } = parsePermitId(localId);
  await client.get(backcountryPrimeUrl());
  await client.get(applyPermitUrl(areaId)); // set current permit facility
  const html = await client.get(permitCalendarUrl(areaId, startISO));
  const z = parseBackcountryCalendar(html, startISO).find((x) => x.zone === zone);
  const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => addDaysISO(startISO, i));
  const sites: SiteAvailability[] = z
    ? [{ siteId: zone, label: zone, available: z.available, siteUrl: z.siteUrl, quota: z.quota }]
    : [];
  return { windowStart: startISO, windowDays: WINDOW_DAYS, dates, sites };
}

/* ----- vacancies ----- */

async function findVacancies(
  client: ParksClient,
  localId: string,
  startISO: string,
  endISO: string,
  nights: number,
): Promise<VacancyResult> {
  const lastNeeded = addDaysISO(endISO, nights);
  const avail = await getAvailabilityRange(client, localId, startISO, lastNeeded);
  const vacancies = computeVacancies(avail.sites, startISO, endISO, nights);
  return { parkId: localId, jurisdiction: JURISDICTION, bookingUrl: localBookingUrl(localId), vacancies };
}

async function getAvailabilityRange(
  client: ParksClient,
  localId: string,
  startISO: string,
  endISO: string,
): Promise<AvailabilityResult> {
  let merged: AvailabilityResult | null = null;
  let start = startISO;
  let guard = 0;
  while (start <= endISO && guard++ < 40) {
    const res = await fetchWindow(client, localId, start);
    merged = merged ? mergeAvailability(merged, res) : res;
    start = addDaysISO(start, WINDOW_DAYS);
  }
  return merged!;
}

/* ----- info ----- */

async function campgroundInfo(client: ParksClient, localId: string): Promise<CampgroundInfo> {
  if (isBackcountry(localId)) {
    const { areaId, zone } = parsePermitId(localId);
    return { parkId: localId, name: zone, jurisdiction: JURISDICTION, bookingUrl: permitBookingUrl(areaId) };
  }
  const html = await client.get(facilityDetailsUrl(localId));
  const d = parseFacilityDetails(html);
  return {
    parkId: localId,
    name: d.name,
    jurisdiction: JURISDICTION,
    description: d.description,
    lat: d.lat,
    lng: d.lng,
    bookingUrl: bookingUrl(localId),
  };
}

/* ----- provider ----- */

const client = new ParksClient();

export const albertaProvider: Provider = {
  prefix: "ab",
  jurisdiction: JURISDICTION,
  list: () => listCampgrounds(client),
  availability: (id, s, n) => getAvailability(client, id, s, n),
  vacancies: (id, s, e, n) => findVacancies(client, id, s, e, n),
  info: (id) => campgroundInfo(client, id),
};

/* ----- shared helpers (used by other providers too) ----- */

export function computeVacancies(
  sites: SiteAvailability[],
  startISO: string,
  endISO: string,
  nights: number,
): Vacancy[] {
  const vacancies: Vacancy[] = [];
  for (const site of sites) {
    const set = new Set(site.available);
    for (let d = startISO; d <= endISO; d = addDaysISO(d, 1)) {
      let ok = true;
      for (let n = 0; n < nights; n++) {
        if (!set.has(addDaysISO(d, n))) {
          ok = false;
          break;
        }
      }
      if (ok) {
        vacancies.push({
          siteId: site.siteId,
          label: site.label,
          loop: site.loop,
          siteUrl: site.siteUrl,
          quota: site.quota,
          checkIn: d,
          checkOut: addDaysISO(d, nights),
          nights,
        });
      }
    }
  }
  return vacancies;
}

function emptyWindow(startISO: string): AvailabilityResult {
  return { windowStart: startISO, windowDays: WINDOW_DAYS, dates: [], sites: [] };
}

function mergeAvailability(a: AvailabilityResult, b: AvailabilityResult): AvailabilityResult {
  const sites = new Map(a.sites.map((s) => [s.siteId, { ...s, available: [...s.available] }]));
  for (const s of b.sites) {
    const ex = sites.get(s.siteId);
    if (ex) ex.available = [...new Set([...ex.available, ...s.available])].sort();
    else sites.set(s.siteId, { ...s, available: [...s.available] });
  }
  return {
    parkSlug: a.parkSlug || b.parkSlug,
    windowStart: a.windowStart,
    windowDays: a.windowDays,
    dates: [...new Set([...a.dates, ...b.dates])].sort(),
    sites: [...sites.values()],
  };
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
