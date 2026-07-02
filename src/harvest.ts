/**
 * Server-side availability harvest store. We periodically fetch a rolling 90-day
 * availability window for every campground and store it as a compact per-site
 * bitmap (1 bit/day). Any later query — pick a date + nights, light up the whole
 * map, scroll a mini-month — becomes an instant bitmap lookup instead of an upstream
 * call. Backed by SQLite at <CACHE_DIR>/harvest.db (bind-mounted; survives restarts).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { addDaysISO, campgroundChildId, campgroundOf, splitCampgroundId } from "./parks/service.ts";
import type { SiteAvailability } from "./providers/types.ts";

export const HARVEST_DAYS = 90;
const BYTES = Math.ceil(HARVEST_DAYS / 8);

/** How often we aim to refresh a park, by how full it is: near-capacity parks change
 * fast (cancellations matter) so refresh often; wide-open ones barely change. Aspira
 * (AB/SK) gets a gentler floor since each harvest is expensive. Shared with the
 * harvester so the schedule and the staleness label agree. */
export function refreshIntervalMs(parkId: string, occupancy: number): number {
  let hours: number;
  if (occupancy >= 0.85) hours = 4;
  else if (occupancy >= 0.6) hours = 8;
  else if (occupancy >= 0.3) hours = 16;
  else hours = 24; // wide open — barely changes
  if (parkId.startsWith("ab") || parkId.startsWith("sk")) hours = Math.max(hours, 8);
  return hours * 60 * 60 * 1000;
}
// "Stale" means a refresh is overdue (harvester falling behind / genuinely old), not
// merely "older than a fixed cutoff" — so it scales with the park's OWN cadence (a flat
// 12h floor made fast-tier parks read fresh while the harvester already treated them due).
function staleAfter(parkId: string, occupancy: number): number {
  return refreshIntervalMs(parkId, occupancy) * 1.25;
}

const db = openDb();

function openDb(): Database | null {
  const dir = process.env.CACHE_DIR;
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const d = new Database(`${dir}/harvest.db`);
    d.run("PRAGMA journal_mode = WAL");
    d.run(
      "CREATE TABLE IF NOT EXISTS site_avail (parkId TEXT, siteId TEXT, label TEXT, loop TEXT, siteUrl TEXT, quota TEXT, bits BLOB, PRIMARY KEY(parkId, siteId))",
    );
    d.run("CREATE INDEX IF NOT EXISTS idx_site_park ON site_avail(parkId)");
    d.run(
      "CREATE TABLE IF NOT EXISTS park_meta (parkId TEXT PRIMARY KEY, windowStart TEXT, windowDays INTEGER, occupancy REAL, jurisdiction TEXT, bookingUrl TEXT, siteCount INTEGER, updated INTEGER, ok INTEGER, error TEXT)",
    );
    for (const col of ["windowDays INTEGER", "occupancy REAL"]) {
      try {
        d.run(`ALTER TABLE park_meta ADD COLUMN ${col}`); // migrate older DBs
      } catch {
        /* column already exists */
      }
    }
    return d;
  } catch (e) {
    // Read-write open failed (e.g. a read-only cache mount). Fall back to read-only so we
    // can still SERVE previously-harvested data; all writes below no-op (best-effort).
    try {
      const ro = new Database(`${dir}/harvest.db`, { readonly: true });
      console.warn(`harvest: opened READ-ONLY — cache dir not writable, data won't refresh: ${(e as Error).message}`);
      return ro;
    } catch {
      console.warn(`harvest: disabled (cannot open SQLite): ${(e as Error).message}`);
      return null;
    }
  }
}

// Disk writes are best-effort: a read-only cache DB must never crash a read or a booking
// query — it just means the harvest can't be persisted/refreshed. Warn at most every 5 min
// (a warn-once latch would hide a persistent read-only condition forever) and log recovery.
const WRITE_WARN_INTERVAL_MS = 5 * 60 * 1000;
let lastWriteWarn = 0;
let writeFailing = false;
function safeWrite(fn: () => void): boolean {
  try {
    fn();
    if (writeFailing) {
      writeFailing = false;
      console.warn(`[${new Date().toISOString()}] harvest: writes recovered`);
    }
    return true;
  } catch (e) {
    const now = Date.now();
    if (now - lastWriteWarn > WRITE_WARN_INTERVAL_MS) {
      lastWriteWarn = now;
      writeFailing = true;
      console.warn(`[${new Date().toISOString()}] harvest: write failed (read-only cache?): ${(e as Error).message}`);
    }
    return false;
  }
}

export function harvestEnabled(): boolean {
  return db != null;
}

// Notify listeners (the SSE layer) whenever a park's cached availability changes, so the
// map can push just-changed dots live instead of polling.
const harvestListeners = new Set<(parkId: string) => void>();
export function onHarvestUpdate(cb: (parkId: string) => void): () => void {
  harvestListeners.add(cb);
  return () => harvestListeners.delete(cb);
}
function emitHarvest(parkId: string): void {
  for (const cb of harvestListeners) {
    try {
      cb(parkId);
    } catch (e) {
      console.warn(`harvest: live listener failed for ${parkId}: ${(e as Error).message}`);
    }
  }
}

function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function getBit(bits: Uint8Array, i: number): boolean {
  return (bits[i >> 3] & (1 << (i & 7))) !== 0;
}

/* ----- write ----- */

export function storeHarvest(
  parkId: string,
  windowStart: string,
  windowDays: number,
  jurisdiction: string,
  bookingUrl: string,
  sites: SiteAvailability[],
): void {
  if (!db) return;
  const ins = db.prepare(
    "INSERT OR REPLACE INTO site_avail (parkId, siteId, label, loop, siteUrl, quota, bits) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let availDays = 0;
  const tx = db.transaction(() => {
    db!.run("DELETE FROM site_avail WHERE parkId = ?", [parkId]);
    for (const s of sites) {
      const bits = new Uint8Array(BYTES);
      for (const date of s.available) {
        const i = daysBetween(windowStart, date);
        if (i >= 0 && i < windowDays) {
          bits[i >> 3] |= 1 << (i & 7);
          availDays++;
        }
      }
      ins.run(parkId, s.siteId, s.label, s.loop ?? null, s.siteUrl ?? null, s.quota ?? null, Buffer.from(bits));
    }
    // Occupancy = fraction of site-days that are booked (1 = full, 0 = wide open).
    const totalDays = sites.length * windowDays;
    const occupancy = totalDays > 0 ? Math.max(0, Math.min(1, 1 - availDays / totalDays)) : 0;
    db!.run(
      "INSERT OR REPLACE INTO park_meta (parkId, windowStart, windowDays, occupancy, jurisdiction, bookingUrl, siteCount, updated, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)",
      [parkId, windowStart, windowDays, occupancy, jurisdiction, bookingUrl, sites.length, Date.now()],
    );
  });
  if (safeWrite(tx)) emitHarvest(parkId);
}

/** Merge a live re-check of [rangeStart, rangeStart+rangeDays) into an existing harvest,
 * updating only those days' bits per site and bumping `updated` — so a "confirm" refreshes
 * the queried dates without shrinking the park's 90-day window. Falls back to a full store
 * if the park has no harvest yet. */
export function refreshHarvestRange(
  parentId: string,
  jurisdiction: string,
  bookingUrl: string,
  rangeStartISO: string,
  rangeDays: number,
  sites: SiteAvailability[],
): void {
  if (!db) return;
  const m = okMeta(parentId);
  if (!m) {
    storeHarvest(parentId, rangeStartISO, rangeDays, jurisdiction, bookingUrl, sites);
    return;
  }
  const windowDays = m.windowDays ?? HARVEST_DAYS;
  const base = daysBetween(m.windowStart, rangeStartISO);
  // A confirm on a date beyond the harvested edge EXTENDS the window (grow each site's
  // bitmap) instead of discarding the live data — upstream booking windows run past our
  // 90 days, so "beyond the window" dates are often genuinely bookable and the cache
  // should learn them rather than serving "pending" forever. Only when the range is
  // CONTIGUOUS with the stored window (base <= windowDays): a gap of never-checked days
  // would otherwise read as zero bits = "full" for every site. Capped for sanity.
  const newWindowDays =
    sites.length > 0 && base >= 0 && base <= windowDays
      ? Math.min(Math.max(windowDays, base + rangeDays), 366)
      : windowDays;
  const newBytes = Math.ceil(newWindowDays / 8);
  // Does this re-check span the whole stored window? Only then can a row's bits be
  // authored from scratch (otherwise the un-refreshed days would be left at 0 = FULL).
  const coversWholeWindow = base <= 0 && base + rangeDays >= newWindowDays;
  const get = db.query("SELECT bits FROM site_avail WHERE parkId = ? AND siteId = ?");
  const put = db.prepare(
    "INSERT OR REPLACE INTO site_avail (parkId, siteId, label, loop, siteUrl, quota, bits) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  let merged = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const s of sites) {
      const row = get.get(parentId, s.siteId) as { bits: Uint8Array } | null;
      // Brand-new site with only a partial re-check: zero-filling would mark every day
      // OUTSIDE [base, base+rangeDays) as FULL across the rest of the 90-day window —
      // wrong dot colors until the next full harvest. Skip it; storeHarvest will add it
      // with real bits. Author from scratch only when the range covers the whole window.
      if (!row && !coversWholeWindow) {
        skipped++;
        continue;
      }
      const bits = new Uint8Array(Math.max(newBytes, row ? row.bits.length : BYTES));
      if (row) bits.set(row.bits); // grow, preserving existing days
      const avail = new Set(s.available);
      for (let i = 0; i < rangeDays; i++) {
        const day = base + i;
        if (day < 0 || day >= newWindowDays) continue;
        if (avail.has(addDaysISO(rangeStartISO, i))) bits[day >> 3] |= 1 << (day & 7);
        else bits[day >> 3] &= ~(1 << (day & 7));
      }
      put.run(parentId, s.siteId, s.label, s.loop ?? null, s.siteUrl ?? null, s.quota ?? null, Buffer.from(bits));
      merged++;
    }
    // Reconcile deletions: confirm fetches the FULL parent site list (registry.ts
    // confirmAvailability → rawAvailability(parent)), so any stored site missing from
    // the live set was removed upstream. Drop its stale bits so it can't keep showing
    // available. (Guard: only when the live fetch actually returned sites, so a failed/
    // empty upstream call never wipes the whole park.)
    let deleted = 0;
    // Skip reconciliation when the range never overlapped the stored window (a gap
    // confirm merges nothing — deleting "orphans" there would trust a fetch we ignored).
    if (sites.length > 0 && base < newWindowDays) {
      const liveIds = new Set(sites.map((s) => s.siteId));
      const stored = db!
        .query("SELECT siteId FROM site_avail WHERE parkId = ?")
        .all(parentId) as { siteId: string }[];
      const orphans = stored.filter((r) => !liveIds.has(r.siteId)).map((r) => r.siteId);
      for (const id of orphans) db!.run("DELETE FROM site_avail WHERE parkId = ? AND siteId = ?", [parentId, id]);
      deleted = orphans.length;
    }
    // Recompute occupancy over the actual stored bitmaps — it feeds staleAfter() and the
    // harvester's cadence, so a bumped `updated` with stale occupancy would re-flag the
    // just-refreshed park as stale. (Cheap: one park's sites.)
    let availDays = 0, n = 0;
    for (const r of db!.query("SELECT bits FROM site_avail WHERE parkId = ?").all(parentId) as { bits: Uint8Array }[]) {
      n++;
      for (let i = 0; i < newWindowDays; i++) if (getBit(r.bits, i)) availDays++;
    }
    const occupancy = n > 0 ? Math.max(0, Math.min(1, 1 - availDays / (n * newWindowDays))) : (m.occupancy ?? 0);
    db!.run("UPDATE park_meta SET updated = ?, occupancy = ?, siteCount = ?, windowDays = ? WHERE parkId = ?", [
      Date.now(), occupancy, n, newWindowDays, parentId,
    ]);
    if (skipped || deleted) {
      console.log(
        `harvest: refreshRange ${parentId} [${rangeStartISO}+${rangeDays}d] merged=${merged} skipped-new=${skipped} deleted-orphan=${deleted}`,
      );
    }
  });
  if (safeWrite(tx)) emitHarvest(parentId);
}

export function storeError(parkId: string, message: string): void {
  if (!db) return;
  safeWrite(() =>
    db!.run(
      "INSERT INTO park_meta (parkId, updated, ok, error) VALUES (?, ?, 0, ?) " +
        "ON CONFLICT(parkId) DO UPDATE SET updated=excluded.updated, ok=0, error=excluded.error",
      [parkId, Date.now(), message.slice(0, 200)],
    ),
  );
}

interface MetaRow {
  parkId: string;
  windowStart: string;
  windowDays: number | null;
  jurisdiction: string;
  bookingUrl: string;
  updated: number;
  occupancy: number | null;
}
function okMeta(parkId: string): MetaRow | null {
  if (!db) return null;
  return (db
    .query("SELECT parkId, windowStart, windowDays, jurisdiction, bookingUrl, updated, occupancy FROM park_meta WHERE parkId = ? AND ok = 1")
    .get(parkId) as MetaRow) || null;
}

/* ----- read ----- */

export interface CachedAvailability {
  parkId: string;
  jurisdiction: string;
  bookingUrl: string;
  windowStart: string;
  windowDays: number;
  dates: string[];
  sites: SiteAvailability[];
  harvestedAt: number;
  stale: boolean;
}

/** Per-site availability for [startISO, startISO+span] from the harvest, or null if
 * the window isn't covered (caller should fall back to a live fetch). */
export function getCachedAvailability(
  parkId: string,
  startISO: string,
  span: number,
): CachedAvailability | null {
  const { parent, cg } = splitCampgroundId(parkId);
  const m = okMeta(parent);
  if (!m) return null;
  const covered = m.windowDays ?? HARVEST_DAYS;
  const offset = daysBetween(m.windowStart, startISO);
  if (offset < 0 || offset + span > covered) return null; // outside the harvested window
  let rows = db!
    .query("SELECT siteId, label, loop, siteUrl, quota, bits FROM site_avail WHERE parkId = ?")
    .all(parent) as { siteId: string; label: string; loop: string | null; siteUrl: string | null; quota: string | null; bits: Uint8Array }[];
  if (cg) rows = rows.filter((r) => campgroundOf(r.loop) === cg);
  const dates = Array.from({ length: span }, (_, i) => addDaysISO(startISO, i));
  const sites: SiteAvailability[] = rows.map((r) => {
    const available: string[] = [];
    for (let i = 0; i < span; i++) if (getBit(r.bits, offset + i)) available.push(dates[i]);
    return { siteId: r.siteId, label: r.label, loop: r.loop ?? undefined, siteUrl: r.siteUrl ?? undefined, quota: r.quota ?? undefined, available };
  });
  return {
    parkId,
    jurisdiction: m.jurisdiction,
    bookingUrl: m.bookingUrl,
    windowStart: startISO,
    windowDays: span,
    dates,
    sites,
    harvestedAt: m.updated,
    stale: Date.now() - m.updated > staleAfter(parent, m.occupancy ?? 0),
  };
}

type BulkEntry = { available: boolean; siteCount: number; stale: boolean; pending?: boolean };
type MetaLite = { parkId: string; windowStart: string; windowDays: number | null; updated: number; occupancy: number | null };

/** Campground entries for one park (split into per-campground children where needed). */
function entriesForMeta(m: MetaLite, startISO: string, nights: number): Record<string, BulkEntry> {
  const out: Record<string, BulkEntry> = {};
  const offset = daysBetween(m.windowStart, startISO);
  if (offset < 0) return out; // date is in the past / before this harvest's window
  const rows = db!.query("SELECT loop, bits FROM site_avail WHERE parkId = ?").all(m.parkId) as {
    loop: string | null; bits: Uint8Array;
  }[];
  // Group by campground so multi-campground parks (Willow Rock, Bow River…) light up
  // as separate pins matching the catalogue.
  const groups = new Map<string, { loop: string | null; bits: Uint8Array }[]>();
  for (const r of rows) {
    const cg = campgroundOf(r.loop);
    (groups.get(cg) ?? groups.set(cg, []).get(cg)!).push(r);
  }
  const multi = groups.size > 1;
  const pending = offset + nights > (m.windowDays ?? HARVEST_DAYS);
  const stale = Date.now() - m.updated > staleAfter(m.parkId, m.occupancy ?? 0);
  for (const [cg, grp] of groups) {
    const id = multi ? campgroundChildId(m.parkId, cg) : m.parkId;
    if (pending) {
      out[id] = { available: false, siteCount: 0, stale: false, pending: true };
      continue;
    }
    let count = 0;
    for (const r of grp) {
      let ok = true;
      for (let n = 0; n < nights; n++) if (!getBit(r.bits, offset + n)) { ok = false; break; }
      if (ok) count++;
    }
    out[id] = { available: count > 0, siteCount: count, stale };
  }
  return out;
}

/** Map light-up: for every harvested park, is a stay of `nights` from `startISO`
 * available, and is the data stale? `since` (ms) returns only parks re-harvested after
 * that time — a cheap delta for the map's live poll/SSE, so unchanged dots aren't re-sent. */
export function bulkAvailability(startISO: string, nights: number, since = 0): Record<string, BulkEntry> {
  if (!db) return {};
  const metas = db
    .query("SELECT parkId, windowStart, windowDays, updated, occupancy FROM park_meta WHERE ok = 1 AND updated > ?")
    .all(since) as MetaLite[];
  const out: Record<string, BulkEntry> = {};
  for (const m of metas) Object.assign(out, entriesForMeta(m, startISO, nights));
  return out;
}

/** Live push: entries for one park (used over SSE and by /api/confirm). Accepts a parent
 * OR a per-campground child id — park_meta is keyed by parent, so resolve it; the result
 * keys split parents back into their child ids, matching the catalogue / bulk shape. */
export function parkAvailability(parkId: string, startISO: string, nights: number): Record<string, BulkEntry> {
  if (!db) return {};
  const { parent } = splitCampgroundId(parkId);
  const m = db
    .query("SELECT parkId, windowStart, windowDays, updated, occupancy FROM park_meta WHERE parkId = ? AND ok = 1")
    .get(parent) as MetaLite | null;
  return m ? entriesForMeta(m, startISO, nights) : {};
}

/** Mini-month: for each of `days` days from startISO, is a stay of `nights` available? */
export function calendar(
  parkId: string,
  startISO: string,
  nights: number,
  days: number,
): { stale: boolean; harvestedAt: number; cells: { date: string; available: boolean; siteCount: number; unknown?: boolean }[] } | null {
  const { parent, cg } = splitCampgroundId(parkId);
  const m = okMeta(parent);
  if (!m) return null;
  const covered = m.windowDays ?? HARVEST_DAYS;
  let rows = db!.query("SELECT loop, bits FROM site_avail WHERE parkId = ?").all(parent) as { loop: string | null; bits: Uint8Array }[];
  if (cg) rows = rows.filter((r) => campgroundOf(r.loop) === cg);
  const cells: { date: string; available: boolean; siteCount: number; unknown?: boolean }[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDaysISO(startISO, d);
    const offset = daysBetween(m.windowStart, date);
    // unknown: outside the harvested window — "no data", NOT "unavailable".
    if (offset < 0 || offset + nights > covered) { cells.push({ date, available: false, siteCount: -1, unknown: true }); continue; }
    let count = 0;
    for (const r of rows) {
      let ok = true;
      for (let n = 0; n < nights; n++) if (!getBit(r.bits, offset + n)) { ok = false; break; }
      if (ok) count++;
    }
    cells.push({ date, available: count > 0, siteCount: count });
  }
  return { stale: Date.now() - m.updated > staleAfter(parent, m.occupancy ?? 0), harvestedAt: m.updated, cells };
}

export function statusByJurisdiction(): Record<string, { harvested: number; newest: number | null; oldest: number | null; sites: number }> {
  if (!db) return {};
  const rows = db
    .query("SELECT jurisdiction j, COUNT(*) c, MAX(updated) mx, MIN(updated) mn, SUM(siteCount) s FROM park_meta WHERE ok = 1 AND jurisdiction IS NOT NULL GROUP BY jurisdiction")
    .all() as { j: string; c: number; mx: number; mn: number; s: number }[];
  const out: Record<string, { harvested: number; newest: number | null; oldest: number | null; sites: number }> = {};
  for (const r of rows) out[r.j] = { harvested: r.c, newest: r.mx, oldest: r.mn, sites: r.s ?? 0 };
  return out;
}

export function harvestStatus(): { harvested: number; errors: number; oldest: number | null; newest: number | null } {
  if (!db) return { harvested: 0, errors: 0, oldest: null, newest: null };
  const ok = db.query("SELECT COUNT(*) c, MIN(updated) mn, MAX(updated) mx FROM park_meta WHERE ok = 1").get() as { c: number; mn: number | null; mx: number | null };
  const err = db.query("SELECT COUNT(*) c FROM park_meta WHERE ok = 0").get() as { c: number };
  return { harvested: ok.c, errors: err.c, oldest: ok.mn, newest: ok.mx };
}

export interface ParkStatus {
  parkId: string;
  jurisdiction: string | null;
  windowStart: string | null;
  siteCount: number | null;
  updated: number;
  ok: number;
  error: string | null;
}
export function parkStatuses(): ParkStatus[] {
  if (!db) return [];
  return db
    .query("SELECT parkId, jurisdiction, windowStart, siteCount, updated, ok, error FROM park_meta ORDER BY updated DESC")
    .all() as ParkStatus[];
}

export function dbSizes(): Record<string, number> {
  const dir = process.env.CACHE_DIR;
  if (!dir) return {};
  const out: Record<string, number> = {};
  for (const f of ["harvest.db", "harvest.db-wal", "cache.db", "cache.db-wal"]) {
    try {
      out[f] = statSync(`${dir}/${f}`).size;
    } catch {
      /* missing */
    }
  }
  return out;
}

export function windowInfo(): { windowDays: number; today: string } {
  return { windowDays: HARVEST_DAYS, today: new Date().toISOString().slice(0, 10) };
}

/** Distinct campgrounds harvested under a parent park (Willow Rock, Bow River…),
 * with site counts. Empty/single → the park isn't split. Drives catalogue expansion;
 * uses the same campgroundOf() grouping as bulkAvailability so ids line up. */
export function campgroundsOf(parentId: string): { name: string; siteCount: number }[] {
  if (!db) return [];
  const rows = db.query("SELECT loop FROM site_avail WHERE parkId = ?").all(parentId) as { loop: string | null }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const cg = campgroundOf(r.loop);
    counts.set(cg, (counts.get(cg) ?? 0) + 1);
  }
  return [...counts].map(([name, siteCount]) => ({ name, siteCount }));
}

/** When was a park last harvested (ms epoch), or 0 if never / errored. */
export function lastHarvest(parkId: string): { updated: number; windowStart: string | null; windowDays: number; occupancy: number } {
  if (!db) return { updated: 0, windowStart: null, windowDays: 0, occupancy: 0 };
  const r = db.query("SELECT updated, windowStart, windowDays, occupancy, ok FROM park_meta WHERE parkId = ?").get(parkId) as { updated: number; windowStart: string | null; windowDays: number | null; occupancy: number | null; ok: number } | null;
  return r && r.ok
    ? { updated: r.updated, windowStart: r.windowStart, windowDays: r.windowDays ?? 90, occupancy: r.occupancy ?? 0 }
    : { updated: 0, windowStart: null, windowDays: 0, occupancy: 0 };
}
