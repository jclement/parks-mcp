---
name: add-provider
description: Add a new park reservation system (a province or camping operator) to Camp, Eh?. Use when wiring up a new data source like another province or booking platform.
---

# Add a reservation provider

Providers implement the `Provider` interface (`src/providers/types.ts`):
`{ prefix, jurisdiction, list(), availability(), vacancies(), info() }`, and are
registered in `src/providers/registry.ts` (`PROVIDERS`). Park ids are provider-prefixed
(`ab:`, `sk:`, `bc:`, `pc:`); `route()` dispatches by prefix. Two platforms already exist
to copy:

- **Aspira / ReserveAmerica** — HTML scrape behind a Queue-it gate. `src/parks/service.ts`
  `createAspiraProvider(config)`; configs (base host + contract code) in `src/parks/client.ts`
  (`ALBERTA`, `SASKATCHEWAN`). Multi-campground parks auto-split into `:cg:` children.
- **Camis / GoingToCamp** — clean anonymous JSON API. `src/providers/camis.ts`
  `new CamisProvider(prefix, jurisdiction, host)`. Backcountry is detected from
  `resourceCategory` names.

## Steps
1. Choose a unique 2-letter `prefix` and a `jurisdiction` display name.
2. Instantiate/implement the provider and add it to `PROVIDERS` in `registry.ts`.
3. Add the jurisdiction color in `src/landing.ts` `COLOR` + the legend Source row, and in
   `src/dashboard.ts` `SRC`.
4. Coordinates: live API coords win; bake fallbacks into `src/data/coords.json` keyed by the
   prefixed id (geocode if needed — see the `geocode-campgrounds` skill).
5. Update provider-listing copy: welcome text + About legend in `src/landing.ts`, and the MCP
   `description` / `INSTRUCTIONS` in `src/server.ts`.
6. `bunx tsc --noEmit` + `bun test`, then deploy (see the `deploy` skill).

The harvester picks up new parents automatically via `harvestTargets()`; the catalogue
(`listCampgrounds()`) expands multi-campground parks at serve time.
