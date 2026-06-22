import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QueueBlockedError, QueueBusyError } from "./parks/client.ts";
import { recordMcp } from "./stats.ts";
import {
  campgroundInfo,
  confirmAvailability,
  findVacancies,
  getAvailability,
  listCampgrounds,
  searchCampgrounds,
} from "./providers/registry.ts";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
// Compact (unindented) for potentially-large payloads, to stay under tool-result limits.
function okCompact(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}
function fail(e: unknown) {
  const msg =
    e instanceof QueueBlockedError || e instanceof QueueBusyError
      ? e.message
      : `Upstream error: ${(e as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

const PARK_ID = z
  .string()
  .describe("parkId from list_campgrounds (provider-prefixed, e.g. ab:330126, bc:-2147483646_-..., pc:...)");

export function registerTools(server: McpServer) {
  server.tool(
    "list_campgrounds",
    "Browse bookable campgrounds across Alberta Parks, BC Parks, and Parks Canada " +
      "(front-country, backcountry zones, and trails like West Coast Trail). Returns " +
      "compact entries { parkId, name, jurisdiction, type, region }. There are ~387 " +
      "campgrounds, so ALWAYS narrow it down: pass `jurisdiction` and/or a `query` " +
      "(name/region substring), and use `limit`/`offset` to page through the rest. " +
      "To find campgrounds near a place, use `search_campgrounds` instead. Take the " +
      "returned `parkId` to get_availability / find_vacancies / campground_info.",
    {
      query: z.string().optional().describe("Case-insensitive name/region substring, e.g. 'lake', 'Kananaskis'"),
      jurisdiction: z
        .enum(["Alberta Parks", "BC Parks", "Parks Canada"])
        .optional()
        .describe("Restrict to one park system"),
      limit: z.number().int().min(1).max(500).optional().describe("Max entries to return (default 100)"),
      offset: z.number().int().min(0).optional().describe("Skip this many, for paging (default 0)"),
    },
    async ({ query, jurisdiction, limit, offset }) => {
      recordMcp("list_campgrounds");
      try {
        const all = await listCampgrounds();
        const q = query?.trim().toLowerCase();
        const filtered = all.filter(
          (c) =>
            (!jurisdiction || c.jurisdiction === jurisdiction) &&
            (!q || `${c.name} ${c.region ?? ""}`.toLowerCase().includes(q)),
        );
        const off = offset ?? 0;
        const page = filtered.slice(off, off + (limit ?? 100)).map((c) => ({
          parkId: c.parkId,
          name: c.name,
          jurisdiction: c.jurisdiction,
          type: c.type,
          ...(c.region ? { region: c.region } : {}),
        }));
        return okCompact({
          total: filtered.length,
          returned: page.length,
          offset: off,
          nextOffset: off + page.length < filtered.length ? off + page.length : null,
          campgrounds: page,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "search_campgrounds",
    "Find campgrounds by area: filter by name/region text and/or jurisdiction, " +
      "and/or find those within a radius of a place. Use this instead of " +
      "list_campgrounds when the user names a place or region (e.g. 'near Banff', " +
      "'around Calgary within 100km', 'Kananaskis backcountry'). Provide `near` (a " +
      "place name, geocoded) or explicit `lat`/`lng`, with `radiusKm` (default 50). " +
      "Returns matches sorted by distance when a center is given, each with a " +
      "parkId you can pass to the availability tools.",
    {
      query: z.string().optional().describe("Name/region text to match, e.g. 'lake', 'Kananaskis'"),
      jurisdiction: z
        .string()
        .optional()
        .describe("Filter: 'Alberta Parks' | 'BC Parks' | 'Parks Canada'"),
      near: z.string().optional().describe("Place name to center a radius search on, e.g. 'Banff, AB'"),
      lat: z.number().optional().describe("Center latitude (alternative to `near`)"),
      lng: z.number().optional().describe("Center longitude (alternative to `near`)"),
      radiusKm: z.number().positive().max(1000).optional().describe("Search radius in km (default 50)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    },
    async (args) => {
      recordMcp("search_campgrounds");
      try {
        const hits = await searchCampgrounds(args);
        const results = hits.map((c) => ({
          parkId: c.parkId,
          name: c.name,
          jurisdiction: c.jurisdiction,
          type: c.type,
          ...(c.region ? { region: c.region } : {}),
          ...(c.lat != null ? { lat: c.lat, lng: c.lng } : {}),
          ...(c.distanceKm != null ? { distanceKm: c.distanceKm } : {}),
        }));
        return okCompact({ count: results.length, results });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_availability",
    "Get the day-by-day availability for one campground/zone/trail starting at a " +
      "date. Returns each site with the ISO dates on which it is available to book " +
      "(plus permit quota for backcountry). Pass `nights` to extend the window. " +
      "Dates are local to the park.",
    {
      parkId: PARK_ID,
      startDate: ISO.describe("First date of the window (YYYY-MM-DD)"),
      nights: z.number().int().min(1).max(60).optional().describe("Span to cover (default 14)"),
    },
    async ({ parkId, startDate, nights }) => {
      recordMcp("get_availability");
      try {
        // Fast (cache-backed). Call confirm_availability to live-verify before booking.
        return okCompact(await getAvailability(parkId, startDate, nights ?? 14));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "find_vacancies",
    "Find sites/zones at a campground open for a run of consecutive nights with a " +
      "check-in date in the given range. Use this to answer 'is anything free at " +
      "park X between A and B for N nights'. Returns matching sites with " +
      "checkIn/checkOut dates and booking URLs. Results come from a periodically-" +
      "refreshed cache and can be slightly stale — before recommending or booking a " +
      "specific site, call confirm_availability to verify it live.",
    {
      parkId: PARK_ID,
      startDate: ISO.describe("Earliest acceptable check-in date (YYYY-MM-DD)"),
      endDate: ISO.describe("Latest acceptable check-in date (YYYY-MM-DD)"),
      nights: z.number().int().min(1).max(30).describe("Consecutive nights needed"),
    },
    async ({ parkId, startDate, endDate, nights }) => {
      recordMcp("find_vacancies");
      try {
        // Fast (cache-backed) discovery. Live-verify a candidate with confirm_availability.
        const r = await findVacancies(parkId, startDate, endDate, nights);
        return ok({
          parkId,
          jurisdiction: r.jurisdiction,
          startDate,
          endDate,
          nights,
          bookingUrl: r.bookingUrl,
          source: r.source,
          count: r.vacancies.length,
          vacancies: r.vacancies,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "confirm_availability",
    "Live-verify one campground's availability right now, bypassing the cache, and " +
      "refresh the cache with the result. Use this before recommending or booking a " +
      "specific site — list_campgrounds / get_availability / find_vacancies serve a " +
      "periodically-refreshed cache that can be slightly stale, so a site they show as " +
      "open may already be booked. Slower than the cached tools (a live upstream fetch).",
    {
      parkId: PARK_ID,
      startDate: ISO.describe("First date of the window to verify (YYYY-MM-DD)"),
      nights: z.number().int().min(1).max(60).optional().describe("Span to cover (default 14)"),
    },
    async ({ parkId, startDate, nights }) => {
      recordMcp("confirm_availability");
      try {
        return okCompact(await confirmAvailability(parkId, startDate, nights ?? 14));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "campground_info",
    "Get details for one campground: name, jurisdiction, description, " +
      "latitude/longitude, and bookingUrl. Use after list_campgrounds when you need " +
      "coordinates or more than the name.",
    { parkId: PARK_ID },
    async ({ parkId }) => {
      recordMcp("campground_info");
      try {
        return ok(await campgroundInfo(parkId));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
