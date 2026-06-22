---
name: geocode-campgrounds
description: Place split per-campground pins (Willow Rock, etc.) that share their parent park's coords, by geocoding against OSM. Use when campground pins are stacked or missing coordinates.
---

# Geocode split campgrounds

Aspira parks (Bow Valley PP, …) split into per-campground children
(`ab:330258:cg:Willow%20Rock`). A child without its own coords falls back to the parent's,
so siblings stack on one spot. `scripts/geocode-campgrounds.ts` fixes this: for each split
park it queries OSM Overpass (`camp_site` / `camp_pitch` within 25km of the park center),
name-matches each campground, and bakes distinct coords into `src/data/coords.json`
(validated within 45km; campgrounds not in OSM keep the parent coords).

## Run
- Report only: `bun run scripts/geocode-campgrounds.ts --dry`
- Write coords: `bun run scripts/geocode-campgrounds.ts`

Then commit the `src/data/coords.json` diff and deploy (see the `deploy` skill).

## Notes
- The script reads the child list + parent coords from a live `/api/campgrounds`. If the
  deployment URL changed, update `SRC` at the top of the script.
- Overpass is rate-limited; the script spaces requests (~1.5s/park) — a full run is a few minutes.
