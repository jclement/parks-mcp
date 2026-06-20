import { parse, type HTMLElement } from "node-html-parser";

/** A campground (facility) as listed on the camping search page. */
export interface Campground {
  parkId: string;
  name: string;
  slug?: string;
  photo?: string;
  siteTypes: { type: string; count: number }[];
}

/** One site's availability across the calendar window. */
export interface SiteAvailability {
  siteId: string;
  label: string;
  loop?: string;
  /** Direct booking/detail page for this specific site. */
  siteUrl?: string;
  /** Backcountry only: permits remaining, e.g. "6 of 20". */
  quota?: string;
  /** ISO dates (YYYY-MM-DD) on which this site is available to book. */
  available: string[];
}

/** Descriptive details for one campground (from facilityDetails.do). */
export interface FacilityDetails {
  name: string;
  description?: string;
  lat?: number;
  lng?: number;
}

export interface AvailabilityResult {
  parkSlug?: string;
  windowStart: string; // ISO
  windowDays: number;
  /** ISO dates covered by the window, in order. */
  dates: string[];
  sites: SiteAvailability[];
}

const PARK_ID_RE = /parkId=(\d{5,7})/;
const SITE_TYPE_RE = /siteType=([^&]+)/;
const COUNT_RE = /\((\d+)\)\s*$/;
const SLUG_RE = /\/camping\/([^/]+)\/r\/campsiteDetails\.do/;
const SITE_ID_RE = /siteId=(\d+)/;
const AVAIL_ID_RE = /^avail_(\d+)_(\d+)$/;

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Strip a trailing site-type + count from a facility title to recover the park name. */
function parkNameFromTitle(title: string, siteTypeWords: string): string {
  let n = title;
  if (siteTypeWords && n.endsWith(siteTypeWords)) {
    n = n.slice(0, -siteTypeWords.length);
  }
  return n.replace(/\s*\(\d+\)\s*$/, "").trim();
}

/**
 * Parse the camping search page (`unifSearchInterface.do` / `unifSearchResults.do`)
 * into a list of campgrounds. Names come from `a.facility_link[title]`; per-site-type
 * counts from the `site_type_item_arrow_right` links.
 */
export function parseCampgrounds(html: string): Campground[] {
  const root = parse(html);
  const byId = new Map<string, Campground>();

  for (const a of root.querySelectorAll("a.facility_link")) {
    const href = a.getAttribute("href") || "";
    const m = href.match(PARK_ID_RE);
    if (!m) continue;
    const parkId = m[1];
    const name = decode(a.getAttribute("title") || a.text || "");
    if (!name) continue;
    if (!byId.has(parkId)) byId.set(parkId, { parkId, name, siteTypes: [] });
  }

  // Site-type breakdown + counts.
  for (const a of root.querySelectorAll("a.site_type_item_arrow_right")) {
    const href = decode(a.getAttribute("href") || "");
    const pm = href.match(PARK_ID_RE);
    const tm = href.match(SITE_TYPE_RE);
    if (!pm || !tm) continue;
    const parkId = pm[1];
    const type = decode(decodeURIComponent(tm[1].replace(/\+/g, " ")));
    const title = decode(a.getAttribute("title") || "");
    const cm = title.match(COUNT_RE);
    const count = cm ? Number(cm[1]) : 0;

    let cg = byId.get(parkId);
    if (!cg) {
      // Site-type rows can appear before/without a facility_link; synthesize.
      const name = parkNameFromTitle(title, type);
      cg = { parkId, name, siteTypes: [] };
      byId.set(parkId, cg);
    }
    if (!cg.siteTypes.some((s) => s.type === type)) {
      cg.siteTypes.push({ type, count });
    }
  }

  // Photos: img[pbsrc='/webphotos/ABPP/pid<parkId>/...'].
  for (const img of root.querySelectorAll("img[pbsrc]")) {
    const src = img.getAttribute("pbsrc") || "";
    const m = src.match(/pid(\d{5,7})/);
    if (m && byId.has(m[1]) && !byId.get(m[1])!.photo) {
      byId.get(m[1])!.photo = src.startsWith("http")
        ? src
        : `https://shop.albertaparks.ca${src}`;
    }
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Parse the availability calendar (`campsiteCalendar.do`). The grid shows a 14-day
 * window starting at `windowStart`. Available day-cells self-describe as
 * `a.avail#avail_<siteId>_<dayIndex>` (1-based index into the window); absence of
 * such a cell means the site is not available that day. The site roster + labels
 * come from `.siteListLabel` anchors; park slug from the campsiteDetails href.
 */
export function parseAvailability(html: string, windowStart: string): AvailabilityResult {
  const root = parse(html);

  // Roster: dedupe by siteId (the grid is rendered twice in some layouts).
  const roster = new Map<string, SiteAvailability>();
  let parkSlug: string | undefined;

  for (const label of root.querySelectorAll(".siteListLabel")) {
    const a = label.querySelector("a");
    const href = a?.getAttribute("href") || "";
    const sm = href.match(SITE_ID_RE);
    if (!sm) continue;
    const siteId = sm[1];
    if (!parkSlug) {
      const slugM = href.match(SLUG_RE);
      if (slugM) parkSlug = slugM[1];
    }
    const text = decode(a?.text || label.text || "");
    const loop = nearestLoop(label);
    const siteUrl = href ? absUrl(decode(href)) : undefined;
    if (!roster.has(siteId)) {
      roster.set(siteId, { siteId, label: text, loop, siteUrl, available: [] });
    }
  }

  // Available cells.
  let maxIdx = 0;
  const avail = root.querySelectorAll("a.avail");
  for (const cell of avail) {
    const id = cell.getAttribute("id") || "";
    const m = id.match(AVAIL_ID_RE);
    if (!m) continue;
    const siteId = m[1];
    const dayIdx = Number(m[2]); // 1-based
    if (dayIdx > maxIdx) maxIdx = dayIdx;

    let site = roster.get(siteId);
    if (!site) {
      // Available cell for a site not in the roster list: synthesize from aria-label.
      const aria = cell.getAttribute("aria-label") || "";
      const lm = aria.match(/for\s+(\S+)\s+on/);
      site = { siteId, label: lm ? lm[1] : siteId, available: [] };
      roster.set(siteId, site);
    }
    const date = addDaysISO(windowStart, dayIdx - 1);
    if (!site.available.includes(date)) site.available.push(date);
  }

  const windowDays = Math.max(maxIdx, 14);
  const dates = Array.from({ length: windowDays }, (_, i) => addDaysISO(windowStart, i));
  for (const s of roster.values()) s.available.sort();

  return {
    parkSlug,
    windowStart,
    windowDays,
    dates,
    sites: [...roster.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
  };
}

/** Walk previous siblings/ancestors to find the loop name for a site row. */
function nearestLoop(el: HTMLElement): string | undefined {
  let node: HTMLElement | null = el;
  for (let hops = 0; node && hops < 6; hops++) {
    const loop = node.querySelector?.(".loopName");
    if (loop) return decode(loop.getAttribute("title") || loop.text || "") || undefined;
    node = node.parentNode as HTMLElement | null;
  }
  return undefined;
}

function absUrl(href: string): string {
  if (href.startsWith("http")) return href;
  return `https://shop.albertaparks.ca${href.startsWith("/") ? "" : "/"}${href}`;
}

/** A backcountry zone (e.g. Point) within an area's trip-permit calendar. */
export interface BackcountryZone {
  zone: string;
  available: string[];
  siteUrl?: string;
  /** e.g. "6 of 20" permits remaining, when available. */
  quota?: string;
}

/**
 * Parse `singleTripPermitCalendar.do` into per-zone availability. Each `.avail_row`
 * has a `.stiPermitRow` label cell (`.entranceCode` = zone name, e.g. "Point") then
 * 14 day cells classed `status a` (available, `title` carries the permit quota) or
 * `status r` (full). Window is 14 days from `windowStart`.
 */
export function parseBackcountryCalendar(html: string, windowStart: string): BackcountryZone[] {
  const root = parse(html);
  const zones: BackcountryZone[] = [];
  for (const row of root.querySelectorAll(".avail_row")) {
    const labelCell = row.querySelector(".stiPermitRow");
    if (!labelCell) continue; // header row
    const zone = decode(
      labelCell.querySelector(".entranceCode")?.text ||
        labelCell.querySelector(".entranceTxt")?.text ||
        "",
    );
    if (!zone) continue;

    const dayCells = row
      .querySelectorAll(".avail_cell")
      .filter((c) => !c.classList.contains("stiPermitRow"));
    const available: string[] = [];
    let siteUrl: string | undefined;
    let quota: string | undefined;
    dayCells.forEach((c, i) => {
      const cls = ` ${c.getAttribute("class") || ""} `;
      if (!cls.includes(" status ") || !/\bstatus\s+a\b/.test(cls)) return;
      available.push(addDaysISO(windowStart, i));
      const a = c.querySelector("a");
      if (a && !siteUrl) siteUrl = absUrl(decode(a.getAttribute("href") || ""));
      const q = (c.getAttribute("title") || "").match(/\d+ of \d+/);
      if (q && !quota) quota = q[0];
    });
    zones.push({ zone, available, siteUrl, quota });
  }
  return zones;
}

/**
 * Parse facilityDetails.do into name/description/coordinates. Coordinates appear as
 * a "Geography" block (`Latitude: 54.75668 ... Longitude: -111.87873`) and/or
 * schema.org GeoCoordinates microdata.
 */
export function parseFacilityDetails(html: string): FacilityDetails {
  const root = parse(html);
  const name =
    decode(root.querySelector("h1")?.text || "") ||
    decode((root.querySelector("title")?.text || "").replace(/\s*\|.*$/, ""));

  const desc =
    decode(root.querySelector(".facility_description")?.text || "") ||
    decode(root.querySelector("#facilityDescription")?.text || "") ||
    decode(root.querySelector('meta[name="description"]')?.getAttribute("content") || "") ||
    undefined;

  const text = root.text;
  const latM = text.match(/Latitude:\s*(-?\d{1,3}\.\d+)/i);
  const lngM = text.match(/Longitude:\s*(-?\d{1,3}\.\d+)/i);
  const lat = latM ? Number(latM[1]) : undefined;
  const lng = lngM ? Number(lngM[1]) : undefined;

  return { name, description: desc || undefined, lat, lng };
}
