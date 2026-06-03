/**
 * localStorage cache helpers for expensive computed results.
 * Results persist across tab switches and page reloads.
 * Each cache has a TTL — stale results are discarded.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number; // bump to bust old caches on schema changes
}

const VERSION = 3;

function write<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), version: VERSION };
    localStorage.setItem(`sl_${key}`, JSON.stringify(entry));
  } catch { /* quota exceeded or SSR — silently skip */ }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(`sl_${key}`);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (entry.version !== VERSION) { localStorage.removeItem(`sl_${key}`); return null; }
    if (Date.now() - entry.timestamp > TTL_MS) { localStorage.removeItem(`sl_${key}`); return null; }
    return entry.data;
  } catch { return null; }
}

function clear(key: string): void {
  try { localStorage.removeItem(`sl_${key}`); } catch { }
}

export const cache = { write, read, clear };
