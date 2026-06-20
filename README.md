# parks-mcp

An **anonymous, read-only** MCP server for western-Canada park camping
reservations. It lets an AI client list campgrounds, read details, check
availability, and find vacancies across multiple park systems through one set of
tools. Runs as a small **Bun** HTTP server (Streamable HTTP MCP transport),
**Dockerized**.

### Coverage (providers)

| Jurisdiction | Platform | Notes |
|---|---|---|
| **Alberta Parks** | ReserveAmerica / Aspira (`shop.albertaparks.ca`) | front-country + Kananaskis backcountry zones |
| **BC Parks** | Camis / GoingToCamp (`camping.bcparks.ca`) | ~145 parks |
| **Parks Canada** | Camis / GoingToCamp (`reservation.pc.gc.ca`) | ~114 incl. **West Coast Trail** |

Each park has a provider-prefixed `parkId` (`ab:…`, `bc:…`, `pc:…`); the tools
route automatically, so callers never deal with the underlying system. See
[SPEC.md](SPEC.md) for reverse-engineering notes.

## Tools

| Tool | Description |
|---|---|
| `list_campgrounds` | **All** bookable units — ~109 front-country campgrounds **and** ~19 backcountry campgrounds (e.g. Point) — id, name, `type`, site-type counts, `bookingUrl`. Start here to get a `parkId`. |
| `campground_info` | Name, description, **latitude/longitude**, and `bookingUrl` for one campground. |
| `get_availability` | Per-site × 14-day availability grid from a start date (paginates **all** sites; `nights` > 14 fetches further). Front-country *and* backcountry. |
| `find_vacancies` | Sites/zones open for N consecutive nights with a check-in in `[startDate, endDate]`; each with a direct `siteUrl`. |

Dates are ISO `YYYY-MM-DD`, America/Edmonton local. Every result carries booking
URLs so you can jump straight to the reservation page.

### Caching

Metadata (the campground list, descriptions, coordinates) barely changes, so it's
cached for **7 days**; availability changes often, so it's cached for **5 minutes**.
The cache is SQLite-backed and, when `CACHE_DIR` is set, persists to
`<CACHE_DIR>/cache.db` — the deploy bind-mounts it so restarts don't lose it (a cold
campground list takes ~7s to build; after that it's instant). Tune or disable via
`CAMPGROUND_CACHE_TTL` / `AVAILABILITY_CACHE_TTL` (seconds; `0` disables).

### Backcountry is blended in

Backcountry campgrounds (e.g. **Point**, in the Kananaskis Lake area) appear right
alongside front-country ones in `list_campgrounds` with `type: "backcountry"` and a
`bc:<areaId>:<zone>` parkId. The availability tools accept that id transparently
and read the trip-permit calendar (`singleTripPermitCalendar.do`), returning the
zone's open dates and permit quota (e.g. `"6 of 20"`). Callers don't need to know
front-country vs backcountry — it's the same tools either way.

## Run with Docker

```sh
docker compose up --build -d        # serves on :3000
# or:
docker build -t parks-mcp .
docker run -d -p 3000:3000 -e MCP_PATH=/your/secret/path parks-mcp
```

MCP endpoint: `http://<host>:3000/burrow/9f3a7c2e1d/mcp` (override via `MCP_PATH`).
`/` serves an interactive map of all campgrounds (pins colored by jurisdiction,
shaped by type, with copyable lat/long, booking links, and lazily-loaded
descriptions); `/api/campgrounds`, `/api/campground?id=`, and `/api/stats` back it.
Coordinates come from each park system where published; for the many that don't
expose any (all of BC/Parks Canada, and Alberta's bulk list), a baked geocoded
lookup table (`src/data/coords.json`, ~280 parks) fills the gaps — website coords
always win. `/healthz` is a health check;
`robots.txt` disallows everything.

### ⚠️ Where you run it matters

The site is fronted by a **Queue-it** waiting room. From a **residential / trusted
IP** the full flow works (verified — listing, availability, and vacancies all
return live data). From some **datacenter IP ranges** (notably Cloudflare Workers,
and possibly some cloud VPSs) Queue-it never grants its durable "accepted" cookie,
so every request re-queues; flat pages still work but the multi-step availability
flow can't complete and returns a clear `QueueBlockedError`. **Run this on a host
whose IP isn't flagged** (a home server / self-hosted box is ideal). This is why
it's a self-hosted container rather than a Cloudflare Worker.

## Configure your MCP client

Point a Streamable-HTTP-capable MCP client at the endpoint, e.g.:

```json
{
  "mcpServers": {
    "alberta-parks": { "url": "http://localhost:3000/burrow/9f3a7c2e1d/mcp" }
  }
}
```

## Develop

```sh
bun install
bun test            # parser unit tests against captured HTML fixtures
bun run typecheck
bun run dev         # watch mode on http://localhost:3000

# end-to-end: drives the MCP endpoint with the SDK client against live upstream
node test/live-client.mjs
```

## Layout

- `src/server.ts` — Bun/`node:http` server: routing, session-managed Streamable HTTP transport.
- `src/mcp.ts` — MCP tool definitions (wraps the service layer).
- `src/parks/client.ts` — HTTP client: Queue-it handshake, cookie jar, redirect following.
- `src/parks/parse.ts` — HTML parsers (campground list, availability grid).
- `src/parks/service.ts` — tool logic (list / availability / vacancies / info).
- `src/landing.ts` — the Leaflet campground map (homepage).
- `src/providers/` — provider registry, shared types, and the Camis (BC/Parks Canada) provider.
- `src/data/coords.json` — baked geocoded fallback coordinates.
- `test/` — parser tests + fixtures + the live MCP client.

## Notes

- Read-only. No login, no booking, no credentials.
- Unofficial reverse engineering; keep request volume low. Personal use.
- HTML scraping is inherently brittle — parsers pin to stable hooks
  (`siteListLabel`, `loopName`, `avail_<siteId>_<day>`); a fixture test guards them.
