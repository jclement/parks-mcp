---
name: integrity-check
description: Verify our cached availability matches the upstream reservation sites by sampling random campgrounds and random dates. Use to audit data accuracy or after harvester/provider changes.
---

# Data integrity check

`scripts/integrity-check.ts` samples random harvested campgrounds and random dates, then
compares our cached availability (`getCachedAvailability`) against a **fresh live fetch**
(`rawAvailability`) from the upstream site. It counts sites with the whole stay available
for each, and flags only divergences beyond a churn tolerance (±max(2, 10%)) — small deltas
are expected cancellation churn since the last harvest.

## Run
Must run where upstream is reachable — the **deploy host / container** (Aspira's Queue-it
blocks datacenter IPs). Inside the running container:

```
bun run scripts/integrity-check.ts                 # 50 parks, 1 date each
bun run scripts/integrity-check.ts --parks 30 --dates 2
bun run scripts/integrity-check.ts --seed 7        # reproducible sample
```

Exit code 0 = all within tolerance; 1 = divergences to review (also printed per line).

## Reading results
- `✗ cached N vs live M (Δ, age)` — a real divergence. A large Δ on a freshly-harvested
  park (low age) suggests a bug (parser, window, campground split); a small Δ on an old
  park is just churn.
- `? no cache for window` — date fell outside the park's harvested window.
- `! <error>` — the live fetch failed (e.g., Queue-it block, upstream down).

Aspira parks paginate and are slow; a 50-park run takes a few minutes. Lower `--parks` for
a quick check, raise `--dates` for deeper coverage per park.
