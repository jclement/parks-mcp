/**
 * Free / public-land camping sites — a static catalogue layer (no live availability,
 * mostly first-come-first-served). Distinct from the reservable park providers.
 *
 * Source: BC Recreation Sites & Trails (RSTBC) — ~1,200 campable forest-service rec
 * sites, published by DataBC as a WFS point layer. Open Government Licence – BC.
 * Other sources (OSM tourism=camp_site nationwide, Alberta PLUZ zones) can be layered
 * in later behind the same endpoint.
 */
import { cached, ttlMs } from "../parks/cache.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const PUBLIC_TTL = ttlMs("PUBLIC_LANDS_TTL", 7 * 24 * 60 * 60); // 7 days; this data barely changes

export interface PublicSite {
  id: string;
  name: string;
  lat: number;
  lng: number;
  source: string; // e.g. "BC Rec Sites & Trails"
  town?: string;
  sites?: number; // known designated campsites, if published
}

const BC_RSTBC_WFS =
  "https://openmaps.gov.bc.ca/geo/pub/WHSE_FOREST_TENURE.FTEN_REC_SITE_POINTS_SVW/ows" +
  "?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeName=pub:WHSE_FOREST_TENURE.FTEN_REC_SITE_POINTS_SVW" +
  "&outputFormat=application/json&SRSNAME=EPSG:4326";

interface RstbcProps {
  FOREST_FILE_ID?: string;
  PROJECT_NAME?: string;
  SITE_LOCATION?: string;
  NUM_CAMP_SITES?: number;
  [k: string]: unknown;
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

/** A rec site is "campable" if it lists designated campsites or a camping activity. */
function isCampable(p: RstbcProps): boolean {
  if ((p.NUM_CAMP_SITES ?? 0) > 0) return true;
  return Object.keys(p).some((k) => /^ACTIVITY_DESC/.test(k) && /camp/i.test(String(p[k] ?? "")));
}

async function fetchBcRecSites(): Promise<PublicSite[]> {
  const res = await fetch(BC_RSTBC_WFS, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`BC Rec Sites WFS ${res.status}`);
  const fc = (await res.json()) as {
    features: { properties: RstbcProps; geometry: { coordinates: [number, number] } | null }[];
  };
  const out: PublicSite[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties;
    const g = f.geometry;
    if (!g || !Array.isArray(g.coordinates)) continue;
    if (!isCampable(p)) continue;
    const [lng, lat] = g.coordinates;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    out.push({
      id: `bcrec:${p.FOREST_FILE_ID || `${lat},${lng}`}`,
      name: p.PROJECT_NAME ? titleCase(p.PROJECT_NAME) : "Recreation site",
      lat,
      lng,
      source: "BC Rec Sites & Trails",
      town: p.SITE_LOCATION ? titleCase(p.SITE_LOCATION) : undefined,
      sites: (p.NUM_CAMP_SITES ?? 0) > 0 ? p.NUM_CAMP_SITES : undefined,
    });
  }
  return out;
}

/** All free / public-land camping sites (cached). Best-effort per source. */
export function publicLands(): Promise<PublicSite[]> {
  return cached("publiclands:all", PUBLIC_TTL, async () => {
    const sources = await Promise.allSettled([fetchBcRecSites()]);
    return sources.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
  });
}
