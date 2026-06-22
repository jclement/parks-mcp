---
name: harvest-check
description: Inspect the availability harvester — freshness, coverage, errors, and why pins look stale, grey, or empty. Use when availability seems missing, stale, or wrong.
---

# Check the harvester

The harvester (`src/harvester.ts`) refreshes a rolling 90-day availability window per park
into a SQLite bitmap store (`src/harvest.ts`) so the map and MCP serve instant lookups.
Two lanes run in parallel — **camis** (BC/PC, one fast JSON call) and **aspira** (AB/SK,
slow paginated scrape). Cadence is **adaptive by occupancy** (`refreshIntervalMs`): busy
parks ~4–8h, wide-open ~24h. Aspira fills 30 days first, then expands to 90.

## Where to look
- **Ops dashboard**: `/dashboard` (HTML) and `/api/dashboard` (JSON) — per-source coverage,
  recent harvests, failures, DB sizes, cadence.
- **Verify a park** against the live site: compare `getCachedAvailability(id, date, nights)`
  to a fresh `rawAvailability(id, date, nights)` — exact matches mean the cache is faithful;
  small deltas are just cancellation churn since the last harvest.

## Reading the pins
- **Stale (orange ring)** = a refresh is *overdue* — age > 1.5× that park's own interval
  (min 12h), NOT a flat cutoff. Widespread false-stale means the staleness threshold and the
  refresh cadence disagree; both must derive from `refreshIntervalMs`.
- **Filling (grey ring)** = harvested, but the requested date is deeper than the park's current
  window (mid 30→90 day expansion).
- **No ring / not lit** = not harvested yet, or date outside the 90-day window.

## Common causes
- Queue-it block (Aspira) from datacenter IPs → harvest fails; needs a residential/home IP.
- After a redeploy the harvester restarts and re-warms; near-term fills in minutes, full 90-day
  takes longer.
