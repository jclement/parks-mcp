# Alberta Parks MCP — Spec

An **anonymous, read-only** MCP server, deployed as a **Cloudflare Worker**, that
fronts `shop.albertaparks.ca` so an AI client can search campgrounds and find
campsite vacancies. No account, no credentials, no booking (read-only).

## Goals

Expose MCP tools to:
- `list_campgrounds` — all Alberta Parks camping facilities (id, name, slug).
- `get_availability` — per-site, per-day availability grid for one campground.
- `find_vacancies` — scan a date window for sites open for N consecutive nights.
- `campground_info` — details/description for one campground.

Non-goals (for now): login, booking, day-use/tours/backcountry permits.

## Upstream: how the site works

Platform: **ReserveAmerica / Aspira "UNIF"** (Java/Apache). Contract code: **`ABPP`**.
Everything below is anonymous HTML (no JSON API). Dates are **`MM/DD/YYYY`**,
timezone **America/Edmonton**.

### Two gates in front of every request
1. **Queue-it** — a cold request `302`s to `go.aspiraconnect.com`. In `safetynet`
   mode it auto-issues a token (no human, no wait). You must follow the redirect
   chain and keep cookies. Can become a real FIFO queue at peak drop times.
2. **Java session** — `JSESSIONID`, issued once through the queue.

### Session handshake
`GET https://shop.albertaparks.ca/` following redirects:
`root → go.aspiraconnect.com → shop...?queueittoken=… (200)`.
Capture cookies: **`Queue-it-token`**, **`JSESSIONID`**, **`AWSALB`**, resend them
on data requests. In a Worker: `redirect: "manual"`, read each `Set-Cookie` via
`headers.getSetCookie()`, build your own `Cookie:` header, follow the chain.
On any later response that 302s back to `go.aspiraconnect.com`, redo the handshake
and retry once. Cache the cookie jar briefly (per-isolate memory; optional KV).

### Endpoints (all GET, anonymous, HTML)
Base `https://shop.albertaparks.ca`, `contractCode=ABPP`.

| Purpose | Request |
|---|---|
| Camping search page (park list + site types) | `/unifSearchInterface.do?interface=dsearch&interest=camping&tti=Camping` |
| Cross-park search results | `/unifSearchResults.do?contractCode=ABPP&interest=camping&...` |
| **Availability calendar** | `/campsiteCalendar.do?page=calendar&contractCode=ABPP&parkId=<id>&calarvdate=MM/DD/YYYY&sitepage=true` |
| Facility details | `/facilityDetails.do?contractCode=ABPP&parkId=<id>` |

Park IDs are in the `33xxxx` range (seen: 330101, 330126, 330152, 330157, 330258,
330290, 330291). Site types: `Power, Unserviced, Tent, Group, Cabin, FCFS`.

### Availability calendar HTML shape (verified against live HTML)
- The window is **14 consecutive days** starting at `calarvdate`. Page forward by
  re-requesting with `calarvdate` advanced 14 days (`startIdx`/`resultNext` exist
  but recomputing the date is simpler).
- Each site is a row. Site identity:
  `<div id='div<siteId>' class='siteListLabel'><a href='/camping/<park-slug>/r/campsiteDetails.do?contractCode=ABPP&siteId=<siteId>&...'>Label</a>`
  → `siteId`, the human **park slug** (`beaver-lake-provincial-recreation-area`),
  and the site label.
- Loop name: `<div class='td loopName' title='Beaver Lake'>Beaver Lake</div>`.
- Day cells, in date order: `<div class='td status <code>'>…`
  - `status a` → **available** (cell contains a booking `<a href=…campsiteDetails.do…>`)
  - `status r` → **reserved** (text `R`, no link)
  - other letters (e.g. closed/not-bookable) treated as **unavailable** unless `a`.
  - cells may carry extra classes (`sat`, `sun`) — match the status code as the
    token immediately after `status`.

Parse with a tree parser (`node-html-parser`, works in Workers), not HTMLRewriter
— the grid needs row/cell correlation.

## Server design (Bun + Docker)

> Originally prototyped as a Cloudflare Worker, but Queue-it never grants its
> durable accepted-cookie to Cloudflare's egress IP, so availability can't be
> fetched from there (flat pages work; the multi-redirect availability flow
> re-queues forever). It runs as a self-hosted **Bun** container instead, on a
> host with a trusted IP. See README "Where you run it matters".

- **`/` (root)** — a deliberately goofy **canvas minigame**. No mention of MCP,
  Alberta Parks, or reservations. Pure cover / fun.
- **MCP endpoint** — a **non-obvious path** (not `/mcp`), overridable via the
  `MCP_PATH` env var. Security by obscurity for an unauthenticated endpoint; kept
  off the landing page and out of `robots.txt` (which disallows everything).
- **MCP transport** — `@modelcontextprotocol/sdk` `McpServer` over **Streamable
  HTTP**, served from a `node:http` server under Bun. Sessions are tracked by
  `mcp-session-id` (an `initialize` mints one; later requests reuse the transport).
- **Upstream client** — one `ParksClient` per process; the Queue-it handshake +
  cookie jar are reused across tool calls.
- **Resilience** — if the queue re-queues every request (datacenter IP) the client
  fails fast with `QueueBlockedError`; a genuine busy queue yields `QueueBusyError`.

## Tool contracts

- `list_campgrounds()` → `[{ parkId, name, slug, siteTypes[] }]`
- `get_availability({ parkId, startDate, nights=1 })` →
  `{ parkId, parkSlug, window:{start,end}, sites:[{ siteId, label, loop, days:[{date, status:"available"|"reserved"|"unavailable"}] }] }`
- `find_vacancies({ parkId, startDate, endDate, nights, siteType? })` →
  `[{ siteId, label, loop, checkIn, checkOut }]` — runs of ≥ `nights` consecutive
  `available` days within [startDate, endDate].
- `campground_info({ parkId })` → `{ parkId, name, slug, description, amenities, ... }`

## Testing

- **Unit** (`bun test`): parsers run against captured live HTML fixtures
  (`test/fixtures/`).
- **Integration** (`node test/live-client.mjs`): drives the running MCP endpoint
  with the SDK client through `initialize` / `tools/list` / `tools/call` against
  live upstream; asserts real campgrounds, availability, and vacancies come back.
- **Container smoke**: `docker compose up`, then the same live client against the
  container's MCP path.

## Risks

- HTML scraping is brittle — pin to stable hooks (`siteListLabel`, `loopName`,
  `status a/r`, `siteId=`), add a parser self-test.
- Queue-it can turn real at peak — degrade gracefully.
- Unofficial, no ToS coverage — cache hard, keep volume low, personal use only.
