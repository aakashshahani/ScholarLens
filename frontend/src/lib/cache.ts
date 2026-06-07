/**
 * localStorage cache helpers for expensive computed results.
 * Results persist across tab switches and page reloads.
 * Each cache has a TTL — stale results are discarded.
 *
 * Multi-user: localStorage is per-BROWSER, not per-user, so keys are namespaced
 * by the logged-in user id. The auth layer MUST call `cache.setUser(user.id)`
 * after login / on session restore, and `cache.clearAll()` on logout — otherwise
 * one account could read another's cached results on a shared machine.
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number; // bump to bust old caches on schema changes
}

const VERSION = 4; // bumped: keys are now namespaced per user

// Set by the auth layer. "anon" until a user is known, so pre-login reads/writes
// never collide with a real user's namespace.
let currentUserId = "anon";

function setUser(userId: string | null | undefined): void {
  currentUserId = userId || "anon";
}

function nsKey(key: string): string {
  return `sl_${currentUserId}_${key}`;
}

function write<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now(), version: VERSION };
    localStorage.setItem(nsKey(key), JSON.stringify(entry));
  } catch { /* quota exceeded or SSR — silently skip */ }
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(nsKey(key));
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (entry.version !== VERSION) { localStorage.removeItem(nsKey(key)); return null; }
    if (Date.now() - entry.timestamp > TTL_MS) { localStorage.removeItem(nsKey(key)); return null; }
    return entry.data;
  } catch { return null; }
}

function clear(key: string): void {
  try { localStorage.removeItem(nsKey(key)); } catch { }
}

// Remove EVERY ScholarLens cache entry (all users, incl. legacy un-namespaced
// keys). Call on logout so the next user on this browser starts clean.
function clearAll(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("sl_")) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* SSR or access denied — nothing to clear */ }
}

export const cache = { write, read, clear, setUser, clearAll };
