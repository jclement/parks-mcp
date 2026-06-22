import { ALBERTA, ParksClient, SASKATCHEWAN, type AspiraConfig } from "./client.ts";
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

const WINDOW_DAYS = 14;
// Front-country calendar shows ~10 sites/page; cap paging (biggest parks ~400 sites).
const MAX_PAGES = 60;

/* ----- campground split -----
 * Aspira bundles several campgrounds under one bookable "park" (e.g. Bow Valley PP
 * holds Willow Rock, Bow River, Three Sisters…). Each site's loop carries its
 * campground; the campground is the loop name before " - " (so "Bow Valley - Loop A"
 * and "Willow Rock - First Come, First Served" roll up to "Bow Valley" / "Willow
 * Rock"). A child id "<parkId>:cg:<campground>" addresses one campground. */
const CG_SEP = ":cg:";
export function campgroundOf(loop?: string | null): string {
  // First meaningful segment before " - " ("Bow Valley - Loop A" → "Bow Valley").
  // Skip empty segments (a leading " - ", or a null/blank loop) and fall back to "Main"
  // so a sub-loop never yields a blank "<park>:cg:" child id or a " — <Park>" name.
  const parts = (loop ?? "").split(" - ").map((s) => s.trim()).filter(Boolean);
  return parts[0] || "Main";
}
export function campgroundChildId(parentId: string, cg: string): string {
  return `${parentId}${CG_SEP}${encodeURIComponent(cg)}`;
}
export function splitCampgroundId(parkId: string): { parent: string; cg: string | null } {
  const i = parkId.indexOf(CG_SEP);
  if (i < 0) return { parent: parkId, cg: null };
  const cg = decodeURIComponent(parkId.slice(i + CG_SEP.length)).trim();
  // A malformed/empty segment (e.g. an old "<park>:cg:" link) round-trips to the parent.
  return cg ? { parent: parkId.slice(0, i), cg } : { parent: parkId.slice(0, i), cg: null };
}

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

async function listCampgrounds(
  client: ParksClient,
  jur: string,
  withBackcountry: boolean,
): Promise<CampgroundListItem[]> {
  await client.get(client.campingPrimeUrl());
  const html = await client.get(client.campingResultsUrl());
  const front: CampgroundListItem[] = parseCampgrounds(html, client.config.base).map((c) => ({
    parkId: c.parkId,
    name: c.name,
    jurisdiction: jur,
    type: "campground",
    siteTypes: c.siteTypes,
    bookingUrl: client.bookingUrl(c.parkId),
  }));
  if (!withBackcountry) return front;
  // Backcountry is a bonus layer: never let it break the core campground list.
  const back = await enumerateBackcountry(client, jur).catch(() => [] as CampgroundListItem[]);
  return [...front, ...back];
}

async function enumerateBackcountry(
  client: ParksClient,
  jur: string,
): Promise<CampgroundListItem[]> {
  await client.get(client.backcountryPrimeUrl());
  const areasHtml = await client.get(client.backcountryResultsUrl());
  const areas = parseCampgrounds(areasHtml, client.config.base);
  const start = todayISO();

  const items: CampgroundListItem[] = [];
  for (const area of areas) {
    let zones;
    try {
      await client.get(client.applyPermitUrl(area.parkId));
      const cal = await client.get(client.permitCalendarUrl(area.parkId, start));
      zones = parseBackcountryCalendar(cal, start, client.config.base);
    } catch {
      continue; // skip an area that won't load rather than fail the whole list
    }
    for (const z of zones) {
      items.push({
        parkId: permitId(area.parkId, z.zone),
        name: `${z.zone} — ${shortAreaName(area.name)} (backcountry)`,
        jurisdiction: jur,
        type: "backcountry",
        siteTypes: [],
        bookingUrl: client.permitBookingUrl(area.parkId),
      });
    }
  }
  return items;
}

/* ----- availability ----- */

function localBookingUrl(client: ParksClient, localId: string): string {
  return isBackcountry(localId)
    ? client.permitBookingUrl(parsePermitId(localId).areaId)
    : client.bookingUrl(localId);
}

async function getAvailability(
  client: ParksClient,
  jur: string,
  localId: string,
  startISO: string,
  nights: number,
): Promise<AvailabilityWithMeta> {
  const { parent, cg } = splitCampgroundId(localId);
  const windows = Math.max(1, Math.ceil(nights / WINDOW_DAYS));
  let merged: AvailabilityResult | null = null;
  for (let w = 0; w < windows; w++) {
    const start = addDaysISO(startISO, w * WINDOW_DAYS);
    const res = await fetchWindow(client, parent, start);
    merged = merged ? mergeAvailability(merged, res) : res;
  }
  const sites = cg ? merged!.sites.filter((s) => campgroundOf(s.loop) === cg) : merged!.sites;
  return { ...merged!, sites, parkId: localId, jurisdiction: jur, bookingUrl: localBookingUrl(client, parent) };
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
    const html = await client.get(client.calendarUrl(parkId, startISO, page * 10));
    const res = parseAvailability(html, startISO, client.config.base);
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
  await client.get(client.backcountryPrimeUrl());
  await client.get(client.applyPermitUrl(areaId)); // set current permit facility
  const html = await client.get(client.permitCalendarUrl(areaId, startISO));
  const z = parseBackcountryCalendar(html, startISO, client.config.base).find((x) => x.zone === zone);
  const dates = Array.from({ length: WINDOW_DAYS }, (_, i) => addDaysISO(startISO, i));
  const sites: SiteAvailability[] = z
    ? [{ siteId: zone, label: zone, available: z.available, siteUrl: z.siteUrl, quota: z.quota }]
    : [];
  return { windowStart: startISO, windowDays: WINDOW_DAYS, dates, sites };
}

/* ----- vacancies ----- */

async function findVacancies(
  client: ParksClient,
  jur: string,
  localId: string,
  startISO: string,
  endISO: string,
  nights: number,
): Promise<VacancyResult> {
  const { parent, cg } = splitCampgroundId(localId);
  const lastNeeded = addDaysISO(endISO, nights);
  const avail = await getAvailabilityRange(client, parent, startISO, lastNeeded);
  const sites = cg ? avail.sites.filter((s) => campgroundOf(s.loop) === cg) : avail.sites;
  const vacancies = computeVacancies(sites, startISO, endISO, nights);
  return { parkId: localId, jurisdiction: jur, bookingUrl: localBookingUrl(client, parent), vacancies };
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

async function campgroundInfo(
  client: ParksClient,
  jur: string,
  localId: string,
): Promise<CampgroundInfo> {
  if (isBackcountry(localId)) {
    const { areaId, zone } = parsePermitId(localId);
    return { parkId: localId, name: zone, jurisdiction: jur, bookingUrl: client.permitBookingUrl(areaId) };
  }
  const { parent, cg } = splitCampgroundId(localId);
  const html = await client.get(client.facilityDetailsUrl(parent));
  const d = parseFacilityDetails(html);
  return {
    parkId: localId,
    name: cg ? `${cg} — ${d.name}` : d.name,
    jurisdiction: jur,
    description: d.description,
    lat: d.lat,
    lng: d.lng,
    bookingUrl: client.bookingUrl(parent),
  };
}

/* ----- provider factory ----- */

interface AspiraProviderOptions {
  prefix: string;
  jurisdiction: string;
  config: AspiraConfig;
  /** Enumerate backcountry/trip-permit facilities in list(). Default false. */
  backcountry?: boolean;
}

/**
 * Build a Provider for an Aspira/UNIF reservation shop. Alberta and Saskatchewan
 * share all code, differing only by host + contract code (carried on the client)
 * and jurisdiction label.
 */
function createAspiraProvider(opts: AspiraProviderOptions): Provider {
  const client = new ParksClient(opts.config);
  const jur = opts.jurisdiction;
  const backcountry = opts.backcountry ?? false;
  return {
    prefix: opts.prefix,
    jurisdiction: jur,
    list: () => listCampgrounds(client, jur, backcountry),
    availability: (id, s, n) => getAvailability(client, jur, id, s, n),
    vacancies: (id, s, e, n) => findVacancies(client, jur, id, s, e, n),
    info: (id) => campgroundInfo(client, jur, id),
  };
}

export const albertaProvider: Provider = createAspiraProvider({
  prefix: "ab",
  jurisdiction: "Alberta Parks",
  config: ALBERTA,
  backcountry: true,
});

export const saskParksProvider: Provider = createAspiraProvider({
  prefix: "sk",
  jurisdiction: "Saskatchewan Parks",
  config: SASKATCHEWAN,
  backcountry: false,
});

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
