import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./mcp.ts";
import { LANDING_HTML } from "./landing.ts";
import { campgroundInfo, checkAvailability, geocodeSearch, listCampgrounds } from "./providers/registry.ts";
import { publicLands, publicZones } from "./providers/publiclands.ts";
import { startHarvester } from "./harvester.ts";
import { bulkAvailability, calendar as harvestCalendar, dbSizes, harvestStatus, parkStatuses, statusByJurisdiction, windowInfo } from "./harvest.ts";
import { harvestEvents, mcpStats } from "./stats.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";
import { APPLE_TOUCH_ICON_PNG, FAVICON_PNG, ICON_192_PNG, ICON_512_PNG, ICON_SVG } from "./icons.ts";

const MANIFEST = JSON.stringify({
  name: "Campground Map",
  short_name: "Campgrounds",
  description: "Camping availability across Alberta, BC, and Parks Canada",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0b0f14",
  theme_color: "#0b0f14",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
  ],
});

const ICON_ROUTES: Record<string, { type: string; body: Buffer | string }> = {
  "/manifest.webmanifest": { type: "application/manifest+json", body: MANIFEST },
  "/favicon.svg": { type: "image/svg+xml", body: ICON_SVG },
  "/favicon.ico": { type: "image/png", body: FAVICON_PNG },
  "/icon-192.png": { type: "image/png", body: ICON_192_PNG },
  "/icon-512.png": { type: "image/png", body: ICON_512_PNG },
  "/apple-touch-icon.png": { type: "image/png", body: APPLE_TOUCH_ICON_PNG },
  "/apple-touch-icon-precomposed.png": { type: "image/png", body: APPLE_TOUCH_ICON_PNG },
};

const PORT = Number(process.env.PORT ?? 3000);
// The MCP endpoint lives at an unguessable path (the server is unauthenticated).
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

// Active sessions: an `initialize` mints one; later requests carry mcp-session-id.
const transports = new Map<string, StreamableHTTPServerTransport>();

const INSTRUCTIONS = `Camping reservation search across Alberta Parks, BC Parks, and Parks Canada
(includes backcountry zones and trails like the West Coast Trail).

Typical flow:
1. Find the campground's parkId with search_campgrounds (best when the user names a
   place/area — supports text and "near <place> within Xkm") or list_campgrounds
   (browse with jurisdiction/query filters; it is large, so always filter/page).
2. Pass that parkId to get_availability (per-site open dates) or find_vacancies
   (sites open for N consecutive nights in a date range), or campground_info
   (description + coordinates).

parkId is provider-prefixed and opaque — always use the value returned by a search/
list call verbatim; never construct or guess one. Dates are ISO YYYY-MM-DD. This is
read-only: it reports availability and booking-page URLs but does not make bookings.`;

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "parks-camping", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server);
  return server;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
  );
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // GET (server→client SSE) and DELETE (terminate) must target a live session.
  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) return jsonRpcError(res, 400, "Unknown or missing session id");
    await transport.handleRequest(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return jsonRpcError(res, 400, "Invalid JSON body");
  }

  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (!isInitializeRequest(body)) {
      return jsonRpcError(res, 400, "No valid session; send initialize first");
    }
    // New session.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, body);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (url.pathname === MCP_PATH) {
      await handleMcp(req, res);
      return;
    }
    if (url.pathname === "/api/campgrounds") {
      try {
        const all = await listCampgrounds();
        const pins = all
          .filter((c) => c.lat != null && c.lng != null)
          .map((c) => ({
            id: c.parkId,
            name: c.name,
            j: c.jurisdiction,
            t: c.type,
            lat: c.lat,
            lng: c.lng,
            url: c.bookingUrl,
          }));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" }).end(
          JSON.stringify({ count: pins.length, total: all.length, pins }),
        );
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/publiclands/zones") {
      try {
        const zones = await publicZones();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=86400" }).end(
          JSON.stringify(zones),
        );
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/publiclands") {
      try {
        const sites = await publicLands();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end(
          JSON.stringify({ count: sites.length, sites }),
        );
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/geocode") {
      const q = url.searchParams.get("q") || "";
      try {
        const hits = await geocodeSearch(q);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=3600" }).end(
          JSON.stringify({ hits }),
        );
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/availability") {
      const id = url.searchParams.get("id") || "";
      const start = url.searchParams.get("start") || "";
      const nights = Math.max(1, Math.min(30, Number(url.searchParams.get("nights")) || 1));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad start date" }));
        return;
      }
      try {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" }).end(
          JSON.stringify(await checkAvailability(id, start, nights)),
        );
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/api/availability-bulk") {
      const start = url.searchParams.get("start") || "";
      const nights = Math.max(1, Math.min(30, Number(url.searchParams.get("nights")) || 1));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad start date" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(
        JSON.stringify({ start, nights, parks: bulkAvailability(start, nights) }),
      );
      return;
    }
    if (url.pathname === "/api/calendar") {
      const id = url.searchParams.get("id") || "";
      const start = url.searchParams.get("start") || new Date().toISOString().slice(0, 10);
      const nights = Math.max(1, Math.min(30, Number(url.searchParams.get("nights")) || 1));
      const days = Math.max(7, Math.min(90, Number(url.searchParams.get("days")) || 42));
      const cal = harvestCalendar(id, start, nights, days);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(
        JSON.stringify(cal ? { harvested: true, ...cal } : { harvested: false, cells: [] }),
      );
      return;
    }
    if (url.pathname === "/api/dashboard") {
      const all = await listCampgrounds();
      const totalByJurisdiction: Record<string, number> = {};
      for (const c of all) totalByJurisdiction[c.jurisdiction] = (totalByJurisdiction[c.jurisdiction] ?? 0) + 1;
      const parks = parkStatuses();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
        JSON.stringify({
          totalParks: all.length,
          totalByJurisdiction,
          window: windowInfo(),
          db: dbSizes(),
          status: harvestStatus(),
          bySource: statusByJurisdiction(),
          errors: parks.filter((p) => !p.ok).map((p) => ({ parkId: p.parkId, error: p.error, updated: p.updated })),
          harvest: harvestEvents,
          mcp: mcpStats,
          refresh: {
            adaptive: "4–24h by occupancy",
            windowDays: 90,
            phase1Days: Number(process.env.HARVEST_ASPIRA_PHASE1_DAYS) || 30,
            camisLaneSeconds: Number(process.env.HARVEST_CAMIS_SPACING_SECONDS) || 6,
            aspiraLaneSeconds: Number(process.env.HARVEST_ASPIRA_SPACING_SECONDS) || 12,
          },
        }),
      );
      return;
    }
    if (url.pathname === "/dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DASHBOARD_HTML);
      return;
    }

    if (url.pathname === "/api/about") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=120" }).end(
        JSON.stringify({
          mcpPath: MCP_PATH,
          status: harvestStatus(),
          bySource: statusByJurisdiction(),
          refresh: { adaptive: true, windowDays: 90, phase1Days: Number(process.env.HARVEST_ASPIRA_PHASE1_DAYS) || 30 },
        }),
      );
      return;
    }

    if (url.pathname === "/api/campground") {
      const id = url.searchParams.get("id") || "";
      try {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=600" }).end(
          JSON.stringify(await campgroundInfo(id)),
        );
      } catch (e) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LANDING_HTML);
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (url.pathname === "/api/stats") {
      try {
        const all = await listCampgrounds();
        const byJurisdiction: Record<string, { total: number; campground: number; backcountry: number }> = {};
        for (const c of all) {
          const j = (byJurisdiction[c.jurisdiction] ??= { total: 0, campground: 0, backcountry: 0 });
          j.total++;
          j[c.type]++;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" }).end(
          JSON.stringify({ total: all.length, byJurisdiction }),
        );
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({ error: (e as Error).message }),
        );
      }
      return;
    }
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
      return;
    }
    const iconRoute = ICON_ROUTES[url.pathname];
    if (iconRoute) {
      res.writeHead(200, { "content-type": iconRoute.type, "cache-control": "public, max-age=604800" }).end(iconRoute.body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(PORT, () => {
  console.log(`parks-mcp listening on :${PORT}  (MCP at ${MCP_PATH})`);
  startHarvester();
  // Warm the public-land caches (BC Rec Sites + OSM + AB zones) so the first toggle is instant.
  publicLands().catch(() => {});
  publicZones().catch(() => {});
});
