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
// merely "older than a fixed cutoff" — so it scales with the park's own cadence.
function staleAfter(parkId: string, occupancy: number): number {
  return Math.max(12 * 60 * 60 * 1000, refreshIntervalMs(parkId, occupancy) * 1.5);
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
    console.warn(`harvest: disabled (cannot open SQLite): ${(e as Error).message}`);
    return null;
  }
}

export function harvestEnabled(): boolean {
  return db != null;
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
  tx();
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
  const get = db.query("SELECT bits FROM site_avail WHERE parkId = ? AND siteId = ?");
  const put = db.prepare(
    "INSERT OR REPLACE INTO site_avail (parkId, siteId, label, loop, siteUrl, quota, bits) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const s of sites) {
      const row = get.get(parentId, s.siteId) as { bits: Uint8Array } | null;
      const bits = row ? new Uint8Array(row.bits) : new Uint8Array(BYTES);
      const avail = new Set(s.available);
      for (let i = 0; i < rangeDays; i++) {
        const day = base + i;
        if (day < 0 || day >= windowDays) continue;
        if (avail.has(addDaysISO(rangeStartISO, i))) bits[day >> 3] |= 1 << (day & 7);
        else bits[day >> 3] &= ~(1 << (day & 7));
      }
      put.run(parentId, s.siteId, s.label, s.loop ?? null, s.siteUrl ?? null, s.quota ?? null, Buffer.from(bits));
    }
    db!.run("UPDATE park_meta SET updated = ? WHERE parkId = ?", [Date.now(), parentId]);
  });
  tx();
}

export function storeError(parkId: string, message: string): void {
  if (!db) return;
  db.run(
    "INSERT INTO park_meta (parkId, updated, ok, error) VALUES (?, ?, 0, ?) " +
      "ON CONFLICT(parkId) DO UPDATE SET updated=excluded.updated, ok=0, error=excluded.error",
    [parkId, Date.now(), message.slice(0, 200)],
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

/** Map light-up: for every harvested park, is a stay of `nights` from `startISO`
 * available, and is the data stale? */
export function bulkAvailability(
  startISO: string,
  nights: number,
  since = 0,
): Record<string, { available: boolean; siteCount: number; stale: boolean; pending?: boolean }> {
  if (!db) return {};
  // `since` (ms) returns only parks re-harvested after that time — a cheap delta for the
  // map's live poll, so unchanged dots aren't re-sent.
  const metas = db
    .query("SELECT parkId, windowStart, windowDays, updated, occupancy FROM park_meta WHERE ok = 1 AND updated > ?")
    .all(since) as {
    parkId: string; windowStart: string; windowDays: number | null; updated: number; occupancy: number | null;
  }[];
  const out: Record<string, { available: boolean; siteCount: number; stale: boolean; pending?: boolean }> = {};
  const siteStmt = db.query("SELECT loop, bits FROM site_avail WHERE parkId = ?");
  for (const m of metas) {
    const offset = daysBetween(m.windowStart, startISO);
    if (offset < 0) continue; // date is in the past / before this harvest's window
    const rows = siteStmt.all(m.parkId) as { loop: string | null; bits: Uint8Array }[];
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
  }
  return out;
}

/** Mini-month: for each of `days` days from startISO, is a stay of `nights` available? */
export function calendar(
  parkId: string,
  startISO: string,
  nights: number,
  days: number,
): { stale: boolean; harvestedAt: number; cells: { date: string; available: boolean; siteCount: number }[] } | null {
  const { parent, cg } = splitCampgroundId(parkId);
  const m = okMeta(parent);
  if (!m) return null;
  const covered = m.windowDays ?? HARVEST_DAYS;
  let rows = db!.query("SELECT loop, bits FROM site_avail WHERE parkId = ?").all(parent) as { loop: string | null; bits: Uint8Array }[];
  if (cg) rows = rows.filter((r) => campgroundOf(r.loop) === cg);
  const cells: { date: string; available: boolean; siteCount: number }[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDaysISO(startISO, d);
    const offset = daysBetween(m.windowStart, date);
    if (offset < 0 || offset + nights > covered) { cells.push({ date, available: false, siteCount: -1 }); continue; }
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
