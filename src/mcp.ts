import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QueueBlockedError, QueueBusyError } from "./parks/client.ts";
import {
  campgroundInfo,
  findVacancies,
  getAvailability,
  listCampgrounds,
  searchCampgrounds,
} from "./providers/registry.ts";

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
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
    "List all bookable units across Alberta Parks, BC Parks, and Parks Canada — " +
      "front-country campgrounds, backcountry zones (e.g. Point), and trails (e.g. " +
      "West Coast Trail) — each with a provider-prefixed parkId, name, jurisdiction, " +
      "type, region, coordinates, and bookingUrl. Call this first to get the parkId; " +
      "the availability tools accept any of them transparently. This is a large list " +
      "(hundreds of parks); filter by name/jurisdiction/region as needed.",
    {},
    async () => {
      try {
        return ok(await listCampgrounds());
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
      try {
        const hits = await searchCampgrounds(args);
        return ok({ count: hits.length, results: hits });
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
      try {
        return ok(await getAvailability(parkId, startDate, nights ?? 14));
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
      "checkIn/checkOut dates and booking URLs.",
    {
      parkId: PARK_ID,
      startDate: ISO.describe("Earliest acceptable check-in date (YYYY-MM-DD)"),
      endDate: ISO.describe("Latest acceptable check-in date (YYYY-MM-DD)"),
      nights: z.number().int().min(1).max(30).describe("Consecutive nights needed"),
    },
    async ({ parkId, startDate, endDate, nights }) => {
      try {
        const r = await findVacancies(parkId, startDate, endDate, nights);
        return ok({
          parkId,
          jurisdiction: r.jurisdiction,
          startDate,
          endDate,
          nights,
          bookingUrl: r.bookingUrl,
          count: r.vacancies.length,
          vacancies: r.vacancies,
        });
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
      try {
        return ok(await campgroundInfo(parkId));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
