// Unit tests for searchRecent.ts — localStorage-backed recent searches.
// Uses a small in-memory localStorage shim so the tests are deterministic
// regardless of the runtime jsdom version.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getRecentSearches,
  pushRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
} from './searchRecent';

class MemStore implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? (this.map.get(k) as string) : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  key(index: number) { return Array.from(this.map.keys())[index] ?? null; }
}

beforeEach(() => {
  const store = new MemStore();
  // @ts-expect-error — patch the global at test setup.
  globalThis.window = { localStorage: store };
});

describe('searchRecent.ts', () => {
  it('returns [] when empty', () => {
    expect(getRecentSearches(false)).toEqual([]);
    expect(getRecentSearches(true)).toEqual([]);
  });

  it('pushes a query to the front', () => {
    pushRecentSearch('наушники');
    pushRecentSearch('подарок');
    expect(getRecentSearches(true)).toEqual(['подарок', 'наушники']);
  });

  it('caps Free users at 3 entries', () => {
    for (const q of ['a1', 'a2', 'a3', 'a4', 'a5']) pushRecentSearch(q);
    expect(getRecentSearches(false)).toEqual(['a5', 'a4', 'a3']);
  });

  it('caps PRO users at 10 entries', () => {
    for (let i = 0; i < 15; i++) pushRecentSearch(`item${i}`);
    expect(getRecentSearches(true)).toHaveLength(10);
    expect(getRecentSearches(true)[0]).toBe('item14');
  });

  it('dedupes case-insensitively (same word, different case → moves to front)', () => {
    pushRecentSearch('Catan');
    pushRecentSearch('book');
    pushRecentSearch('catan'); // dedup
    const out = getRecentSearches(true);
    expect(out).toEqual(['catan', 'book']);
  });

  it('ignores queries shorter than MIN_QUERY (2 chars)', () => {
    pushRecentSearch('a');
    pushRecentSearch('  ');
    pushRecentSearch('');
    expect(getRecentSearches(true)).toEqual([]);
  });

  it('removes a single entry by exact-string match', () => {
    pushRecentSearch('alpha');
    pushRecentSearch('beta');
    pushRecentSearch('gamma');
    removeRecentSearch('beta');
    expect(getRecentSearches(true)).toEqual(['gamma', 'alpha']);
  });

  it('clears the whole list', () => {
    pushRecentSearch('xyz');
    pushRecentSearch('abc');
    clearRecentSearches();
    expect(getRecentSearches(true)).toEqual([]);
  });

  it('survives garbage JSON in storage', () => {
    (globalThis.window as unknown as { localStorage: Storage })
      .localStorage.setItem('wb.search.recent.v1', '{not-json');
    expect(getRecentSearches(true)).toEqual([]);
  });

  it('survives non-array JSON in storage', () => {
    (globalThis.window as unknown as { localStorage: Storage })
      .localStorage.setItem('wb.search.recent.v1', '"a string"');
    expect(getRecentSearches(true)).toEqual([]);
  });
});
