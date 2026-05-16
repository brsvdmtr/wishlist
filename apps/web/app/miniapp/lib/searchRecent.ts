// Recent searches — localStorage-only, per-device.
//
// Why localStorage and not a server table:
//   - Search queries can be sensitive (a person's name, an item the user
//     doesn't want others to know they're looking for). Keeping them off
//     the server eliminates a privacy attack surface.
//   - Cross-device sync is not critical for this feature.
//
// Cap depends on PRO status:
//   - Free: 3 most recent
//   - PRO:  10 most recent
//
// SSR-safe: every call guards `typeof window`.

const STORAGE_KEY = 'wb.search.recent.v1';
const MAX_RECENT_FREE = 3;
const MAX_RECENT_PRO = 10;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function read(): string[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

function write(values: string[]): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values.slice(0, MAX_RECENT_PRO)));
  } catch {
    // QuotaExceededError or private mode — silent fallback.
  }
}

/** Read the recent list capped to the user's plan-appropriate limit. */
export function getRecentSearches(isPro: boolean): string[] {
  const max = isPro ? MAX_RECENT_PRO : MAX_RECENT_FREE;
  return read().slice(0, max);
}

/**
 * Push a query to the front of the list (case-insensitive dedup). No-op
 * for empty / whitespace-only / 1-char queries (matches backend min).
 */
export function pushRecentSearch(query: string): void {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed.length < 2) return;
  const current = read();
  const lowered = trimmed.toLowerCase();
  const filtered = current.filter((q) => q.toLowerCase() !== lowered);
  filtered.unshift(trimmed);
  write(filtered.slice(0, MAX_RECENT_PRO));
}

/** Remove a single recent entry by exact-string match (no normalization). */
export function removeRecentSearch(query: string): void {
  const current = read();
  write(current.filter((q) => q !== query));
}

/** Wipe all stored recent searches. */
export function clearRecentSearches(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
