/**
 * TTL cache backed by SQLite (Bun's built-in `bun:sqlite`). Metadata (campground
 * list, descriptions, coordinates) barely changes, so it's cached for a long time;
 * availability changes often, so it gets a short TTL.
 *
 * Concurrent identical calls share one in-flight promise; rejected requests are not
 * cached. If CACHE_DIR is set, resolved entries are written to `<CACHE_DIR>/cache.db`
 * and reloaded on startup, so a restart doesn't lose the (slow-to-build) metadata.
 * All disk I/O is best-effort — an unwritable dir just degrades to an in-memory cache.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

interface Stored {
  value: unknown;
  expires: number;
}

const mem = new Map<string, Stored>();
const inflight = new Map<string, Promise<unknown>>();
const db = openDb();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (ttlMs <= 0) return fn(); // caching disabled for this class
  const now = Date.now();

  const hit = mem.get(key);
  if (hit && hit.expires > now) return Promise.resolve(hit.value as T);
  if (hit) mem.delete(key); // expired

  const flying = inflight.get(key) as Promise<T> | undefined;
  if (flying) return flying;

  const p = fn().then(
    (value) => {
      const expires = now + ttlMs;
      mem.set(key, { value, expires });
      inflight.delete(key);
      persist(key, value, expires);
      return value;
    },
    (err) => {
      inflight.delete(key); // don't cache failures
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

/** Read a TTL (in ms) from an env var holding seconds, falling back to a default. */
export function ttlMs(envName: string, defaultSeconds: number): number {
  const raw = process.env[envName];
  const n = raw == null ? NaN : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : defaultSeconds) * 1000;
}

/** Clear the in-memory cache (test helper; does not touch disk). */
export function clearCache(): void {
  mem.clear();
  inflight.clear();
}

/* ----- SQLite persistence (best-effort) ----- */

function openDb(): Database | null {
  const dir = process.env.CACHE_DIR;
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const d = new Database(`${dir}/cache.db`);
    d.run("PRAGMA journal_mode = WAL");
    d.run("CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
    const now = Date.now();
    d.run("DELETE FROM cache WHERE expires <= ?", [now]);
    for (const row of d.query("SELECT key, value, expires FROM cache").all() as {
      key: string;
      value: string;
      expires: number;
    }[]) {
      try {
        mem.set(row.key, { value: JSON.parse(row.value), expires: row.expires });
      } catch {
        /* skip corrupt row */
      }
    }
    return d;
  } catch (e) {
    console.warn(`cache: persistence disabled (cannot open SQLite in ${dir}): ${(e as Error).message}`);
    return null;
  }
}

let warned = false;
function persist(key: string, value: unknown, expires: number): void {
  if (!db) return;
  try {
    db.run("INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)", [
      key,
      JSON.stringify(value),
      expires,
    ]);
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn(`cache: write failed, continuing in-memory: ${(e as Error).message}`);
    }
  }
}
