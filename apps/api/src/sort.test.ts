import { describe, it, expect } from 'vitest';
import { sortItemsJs, type SortableItem } from './sort.js';

const d = (iso: string) => new Date(iso);

function item(overrides: Partial<SortableItem> & { id: string }): SortableItem {
  return {
    priority: 'MEDIUM',
    status: 'AVAILABLE',
    updatedAt: d('2026-01-01T00:00:00Z'),
    createdAt: d('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('sortItemsJs', () => {
  it('sorts HIGH before MEDIUM before LOW', () => {
    const items = [
      item({ id: 'c', priority: 'LOW' }),
      item({ id: 'a', priority: 'HIGH' }),
      item({ id: 'b', priority: 'MEDIUM' }),
    ];
    const sorted = sortItemsJs(items).map((i) => i.id);
    expect(sorted).toEqual(['a', 'b', 'c']);
  });

  it('puts active items before archived', () => {
    const items = [
      item({ id: 'arch', status: 'COMPLETED', priority: 'HIGH' }),
      item({ id: 'active', status: 'AVAILABLE', priority: 'LOW' }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('active');
  });

  it('tiebreaks by updatedAt DESC within same priority', () => {
    const items = [
      item({ id: 'old', updatedAt: d('2026-01-01T00:00:00Z') }),
      item({ id: 'new', updatedAt: d('2026-06-01T00:00:00Z') }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('new');
  });

  it('tiebreaks by createdAt DESC when updatedAt equal', () => {
    const ts = d('2026-01-01T00:00:00Z');
    const items = [
      item({ id: 'old', updatedAt: ts, createdAt: d('2025-01-01T00:00:00Z') }),
      item({ id: 'new', updatedAt: ts, createdAt: d('2026-01-01T00:00:00Z') }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('new');
  });

  it('tiebreaks by id DESC when all timestamps equal', () => {
    const ts = d('2026-01-01T00:00:00Z');
    const items = [
      item({ id: 'aaa', updatedAt: ts, createdAt: ts }),
      item({ id: 'zzz', updatedAt: ts, createdAt: ts }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('zzz');
  });

  it('unknown/missing priority falls back to rank 1 (treated as LOW)', () => {
    const items = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      item({ id: 'unknown', priority: 'UNKNOWN' as any }),
      item({ id: 'medium', priority: 'MEDIUM' }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('medium');
  });

  it('does not mutate original array', () => {
    const items = [item({ id: 'b', priority: 'LOW' }), item({ id: 'a', priority: 'HIGH' })];
    const original = [...items];
    sortItemsJs(items);
    expect(items[0].id).toBe(original[0].id);
  });

  it('full integration: active HIGH beats archived HIGH, then priority, then dates', () => {
    const base = d('2026-01-01T00:00:00Z');
    const items = [
      item({ id: 'd', status: 'COMPLETED', priority: 'HIGH' }),
      item({ id: 'c', status: 'AVAILABLE', priority: 'LOW' }),
      item({ id: 'b', status: 'AVAILABLE', priority: 'MEDIUM' }),
      item({ id: 'a', status: 'AVAILABLE', priority: 'HIGH', updatedAt: base }),
    ];
    const sorted = sortItemsJs(items).map((i) => i.id);
    expect(sorted).toEqual(['a', 'b', 'c', 'd']);
  });
});
