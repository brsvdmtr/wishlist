import { describe, it, expect } from 'vitest';
import { sortItemsJs, type SortableItem } from './sort.js';

const d = (iso: string) => new Date(iso);

function item(overrides: Partial<SortableItem> & { id: string }): SortableItem {
  return {
    priority: 'MEDIUM',
    status: 'AVAILABLE',
    position: 0,
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

  it('tiebreaks by position ASC within same priority (manual order)', () => {
    const items = [
      item({ id: 'second', position: 10 }),
      item({ id: 'first', position: 1 }),
      item({ id: 'third', position: 100 }),
    ];
    expect(sortItemsJs(items).map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });

  it('tiebreaks by createdAt DESC when position equal', () => {
    const items = [
      item({ id: 'old', position: 0, createdAt: d('2025-01-01T00:00:00Z') }),
      item({ id: 'new', position: 0, createdAt: d('2026-01-01T00:00:00Z') }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('new');
  });

  it('tiebreaks by id DESC when position and createdAt equal', () => {
    const ts = d('2026-01-01T00:00:00Z');
    const items = [
      item({ id: 'aaa', position: 0, createdAt: ts }),
      item({ id: 'zzz', position: 0, createdAt: ts }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('zzz');
  });

  it('position beats createdAt — manual reorder wins over time', () => {
    const items = [
      item({ id: 'newer-but-bumped-down', position: 100, createdAt: d('2026-06-01T00:00:00Z') }),
      item({ id: 'older-but-on-top', position: 0, createdAt: d('2025-01-01T00:00:00Z') }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('older-but-on-top');
  });

  it('unknown/missing priority falls back to rank 1 (treated as LOW)', () => {
    const items = [
      item({ id: 'unknown', priority: 'UNKNOWN' as unknown as SortableItem['priority'] }),
      item({ id: 'medium', priority: 'MEDIUM' }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('medium');
  });

  it('does not mutate original array', () => {
    const items = [item({ id: 'b', priority: 'LOW' }), item({ id: 'a', priority: 'HIGH' })];
    const original = [...items];
    sortItemsJs(items);
    expect(items.map((i) => i.id)).toEqual(original.map((i) => i.id));
  });

  it('full integration: active HIGH beats archived HIGH, then priority, then position', () => {
    const items = [
      item({ id: 'd', status: 'COMPLETED', priority: 'HIGH' }),
      item({ id: 'c', status: 'AVAILABLE', priority: 'LOW', position: 0 }),
      item({ id: 'b', status: 'AVAILABLE', priority: 'MEDIUM', position: 0 }),
      item({ id: 'a', status: 'AVAILABLE', priority: 'HIGH', position: 0 }),
    ];
    const sorted = sortItemsJs(items).map((i) => i.id);
    expect(sorted).toEqual(['a', 'b', 'c', 'd']);
  });

  it('mixed positions across priorities — priority always wins over position', () => {
    const items = [
      item({ id: 'low-front', priority: 'LOW', position: 0 }),
      item({ id: 'high-back', priority: 'HIGH', position: 999 }),
    ];
    expect(sortItemsJs(items)[0].id).toBe('high-back');
  });
});
