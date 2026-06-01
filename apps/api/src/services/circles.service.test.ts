import { describe, it, expect } from 'vitest';

import {
  mapCircleItemForViewer,
  normalizeCircleName,
  normalizeCircleType,
  normalizeEmoji,
  generateInviteToken,
  CircleError,
  type CircleItemInput,
} from './circles.service';

const baseItem = (overrides: Partial<CircleItemInput> = {}): CircleItemInput => ({
  id: 'item1',
  title: 'Sony WH-1000XM5',
  url: 'https://example.com/x',
  priceText: '34 990 ₽',
  currency: 'RUB',
  imageUrl: null,
  priority: 'HIGH',
  description: null,
  categoryId: null,
  ...overrides,
});

const OWNER = 'owner-user';
const ALICE = 'alice-user';

// Reservation state is supplied by the caller (derived from CircleReservation).
describe('mapCircleItemForViewer — surprise invariant', () => {
  it('STRIPS reservation state when the owner views their own list (even if reserved by others)', () => {
    const view = mapCircleItemForViewer(baseItem(), OWNER, OWNER, { reserved: true, reservedByMe: false });
    expect(view.reserved).toBe(false);
    expect(view.reservedByMe).toBe(false);
  });

  it('STRIPS reservation state for the owner even when reservedByMe would be true', () => {
    const view = mapCircleItemForViewer(baseItem(), OWNER, OWNER, { reserved: true, reservedByMe: true });
    expect(view.reserved).toBe(false);
    expect(view.reservedByMe).toBe(false);
  });

  it('exposes reserved=true to a non-owner but never carries the reserver identity', () => {
    const view = mapCircleItemForViewer(baseItem(), ALICE, OWNER, { reserved: true, reservedByMe: false });
    expect(view.reserved).toBe(true); // she sees it's taken (no double-gift)…
    expect(view.reservedByMe).toBe(false); // …but not WHO took it
    expect(view).not.toHaveProperty('reserverUserId'); // shape carries no reserver field at all
  });

  it('marks reservedByMe=true for the viewer who reserved it', () => {
    const view = mapCircleItemForViewer(baseItem(), ALICE, OWNER, { reserved: true, reservedByMe: true });
    expect(view.reserved).toBe(true);
    expect(view.reservedByMe).toBe(true);
  });

  it('an unreserved item is reserved for no one', () => {
    expect(mapCircleItemForViewer(baseItem(), ALICE, OWNER, { reserved: false, reservedByMe: false }).reserved).toBe(false);
    expect(mapCircleItemForViewer(baseItem(), OWNER, OWNER, { reserved: false, reservedByMe: false }).reserved).toBe(false);
  });

  it('passes through display fields unchanged', () => {
    const view = mapCircleItemForViewer(baseItem(), ALICE, OWNER, { reserved: false, reservedByMe: false });
    expect(view).toMatchObject({
      id: 'item1',
      title: 'Sony WH-1000XM5',
      url: 'https://example.com/x',
      priceText: '34 990 ₽',
      currency: 'RUB',
      priority: 'HIGH',
    });
  });
});

describe('normalizeCircleName', () => {
  it('trims and accepts a valid name', () => {
    expect(normalizeCircleName('  Семья  ')).toBe('Семья');
  });
  it('rejects empty / whitespace-only', () => {
    expect(() => normalizeCircleName('   ')).toThrow(CircleError);
    expect(() => normalizeCircleName('')).toThrow(CircleError);
    expect(() => normalizeCircleName(undefined)).toThrow(CircleError);
  });
  it('rejects names longer than 60 chars', () => {
    expect(() => normalizeCircleName('x'.repeat(61))).toThrow(CircleError);
    expect(normalizeCircleName('x'.repeat(60))).toHaveLength(60);
  });
});

describe('normalizeCircleType', () => {
  it('accepts the four canonical types', () => {
    for (const t of ['FAMILY', 'FRIENDS', 'COLLEAGUES', 'COUPLE']) {
      expect(normalizeCircleType(t)).toBe(t);
    }
  });
  it('rejects unknown / non-string types', () => {
    expect(() => normalizeCircleType('SQUAD')).toThrow(CircleError);
    expect(() => normalizeCircleType(123)).toThrow(CircleError);
    expect(() => normalizeCircleType(null)).toThrow(CircleError);
  });
});

describe('normalizeEmoji', () => {
  it('returns null for nullish / non-string / empty', () => {
    expect(normalizeEmoji(null)).toBeNull();
    expect(normalizeEmoji(undefined)).toBeNull();
    expect(normalizeEmoji(42)).toBeNull();
    expect(normalizeEmoji('   ')).toBeNull();
  });
  it('trims and keeps a short emoji', () => {
    expect(normalizeEmoji('  🏡 ')).toBe('🏡');
  });
  it('caps overly long input', () => {
    expect([...normalizeEmoji('🏡'.repeat(40))!].length).toBeLessThanOrEqual(16);
  });
});

describe('generateInviteToken', () => {
  it('produces a url-safe token', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(12);
  });
  it('is effectively unique across calls', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInviteToken()));
    expect(tokens.size).toBe(200);
  });
});
