import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCommentReplyDeepLink, buildReservationReminderDeepLink, buildEventReminderDeepLink, buildItemOpenDeepLink } from './deepLinks';

// Snapshot env vars and restore between cases — the helpers read at call
// time, so each test sets up its own env.
const ORIG_MINI_APP_URL = process.env.MINI_APP_URL;
const ORIG_WEB_ORIGIN = process.env.WEB_ORIGIN;

beforeEach(() => {
  delete process.env.MINI_APP_URL;
  delete process.env.WEB_ORIGIN;
});

afterEach(() => {
  if (ORIG_MINI_APP_URL === undefined) delete process.env.MINI_APP_URL;
  else process.env.MINI_APP_URL = ORIG_MINI_APP_URL;
  if (ORIG_WEB_ORIGIN === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = ORIG_WEB_ORIGIN;
});

describe('buildReservationReminderDeepLink', () => {
  it('uses MINI_APP_URL when set', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx');
  });

  it('falls back to WEB_ORIGIN + /miniapp when MINI_APP_URL is missing', () => {
    process.env.WEB_ORIGIN = 'https://example.com';
    const url = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    expect(url).toBe('https://example.com/miniapp?startapp=rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx');
  });

  it('falls back to wishlistik.ru/miniapp when both env vars missing', () => {
    const url = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    expect(url).toBe('https://wishlistik.ru/miniapp?startapp=rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx');
  });

  it('encodes itemId and reservationMetaId via encodeURIComponent', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    // Realistic cuids never contain reserved chars, but the helper should be
    // safe regardless — the parser symmetrically decodeURIComponent's both
    // segments.
    const url = buildReservationReminderDeepLink('id with space', 'meta/slash');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=rrem_id%20with%20space__m_meta%2Fslash');
  });

  it('produces a payload that starts with rrem_ and contains the __m_ separator', () => {
    const url = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    const startapp = new URL(url).searchParams.get('startapp')!;
    expect(startapp.startsWith('rrem_')).toBe(true);
    expect(startapp).toContain('__m_');
  });

  it('does not collide with the comment-reply deep link prefix', () => {
    const a = buildReservationReminderDeepLink('aaaa1111bbbb', 'cccc2222dddd');
    const b = buildCommentReplyDeepLink('aaaa1111bbbb', 'cccc2222dddd');
    expect(a).not.toBe(b);
    expect(a).toContain('rrem_');
    expect(b).toContain('crpl_');
  });
});

describe('buildCommentReplyDeepLink (regression)', () => {
  it('still uses crpl_ prefix and __c_ separator after refactor', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildCommentReplyDeepLink('cmaa1bb2ccdd', 'cmcc3dd4eeff');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=crpl_cmaa1bb2ccdd__c_cmcc3dd4eeff');
  });

  it('honours the same fallback chain', () => {
    process.env.WEB_ORIGIN = 'https://example.com';
    const url = buildCommentReplyDeepLink('cmaa1bb2ccdd', 'cmcc3dd4eeff');
    expect(url).toBe('https://example.com/miniapp?startapp=crpl_cmaa1bb2ccdd__c_cmcc3dd4eeff');
  });
});

describe('buildEventReminderDeepLink', () => {
  it('uses MINI_APP_URL when set', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildEventReminderDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=evnt_cmaa1bb2ccdd');
  });

  it('falls back to WEB_ORIGIN + /miniapp when MINI_APP_URL is missing', () => {
    process.env.WEB_ORIGIN = 'https://example.com';
    const url = buildEventReminderDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://example.com/miniapp?startapp=evnt_cmaa1bb2ccdd');
  });

  it('falls back to wishlistik.ru/miniapp when both env vars missing', () => {
    const url = buildEventReminderDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://wishlistik.ru/miniapp?startapp=evnt_cmaa1bb2ccdd');
  });

  it('encodes occasionId via encodeURIComponent', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildEventReminderDeepLink('id with space');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=evnt_id%20with%20space');
  });

  it('does not collide with reservation-reminder, comment-reply, or the existing `occasion_` prefix', () => {
    const a = buildEventReminderDeepLink('cmaa1bb2ccdd');
    const b = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    const c = buildCommentReplyDeepLink('cmaa1bb2ccdd', 'cmcc3dd4eeff');
    expect(a).toContain('?startapp=evnt_');
    expect(a).not.toContain('rrem_');
    expect(a).not.toContain('crpl_');
    // The legacy `occasion_` payload (used elsewhere in the bot for copy-link
    // entry) shares `occas`-something — guard against accidental shape drift.
    expect(a).not.toContain('occasion_');
    expect(b).toContain('rrem_');
    expect(c).toContain('crpl_');
  });
});

describe('buildItemOpenDeepLink', () => {
  it('uses MINI_APP_URL when set', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildItemOpenDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=item_cmaa1bb2ccdd');
  });

  it('falls back to WEB_ORIGIN + /miniapp when MINI_APP_URL is missing', () => {
    process.env.WEB_ORIGIN = 'https://example.com';
    const url = buildItemOpenDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://example.com/miniapp?startapp=item_cmaa1bb2ccdd');
  });

  it('falls back to wishlistik.ru/miniapp when both env vars missing', () => {
    const url = buildItemOpenDeepLink('cmaa1bb2ccdd');
    expect(url).toBe('https://wishlistik.ru/miniapp?startapp=item_cmaa1bb2ccdd');
  });

  it('encodes itemId via encodeURIComponent (defensive — real cuids never need it)', () => {
    process.env.MINI_APP_URL = 'https://t.me/WishBoardBot/app';
    const url = buildItemOpenDeepLink('id with space');
    expect(url).toBe('https://t.me/WishBoardBot/app?startapp=item_id%20with%20space');
  });

  it('produces a payload ≤ 64 chars for realistic cuid sizes (Telegram startapp limit)', () => {
    // cuid2 ids are typically 24 chars; `item_` prefix adds 5 → 29 chars total.
    // Allow plenty of headroom but assert the contract.
    const url = buildItemOpenDeepLink('cmaa1bb2ccddeeff0011gghh');
    const startapp = new URL(url).searchParams.get('startapp')!;
    expect(startapp.length).toBeLessThanOrEqual(64);
  });

  it('does not collide with other deep-link prefixes', () => {
    const item = buildItemOpenDeepLink('cmaa1bb2ccdd');
    const rrem = buildReservationReminderDeepLink('cmaa1bb2ccdd', 'cmm9zz8yyxx');
    const crpl = buildCommentReplyDeepLink('cmaa1bb2ccdd', 'cmcc3dd4eeff');
    const evnt = buildEventReminderDeepLink('cmaa1bb2ccdd');
    expect(item).toContain('?startapp=item_');
    // The `item_` prefix is a hard substring of nothing else in the family —
    // accidental drift here would silently break either the reservation
    // notification button (sends item_X) or the existing `<slug>__item_<id>`
    // guest-share format (which lives in MiniApp.tsx, not deepLinks.ts).
    expect(item).not.toContain('rrem_');
    expect(item).not.toContain('crpl_');
    expect(item).not.toContain('evnt_');
    expect(rrem).not.toMatch(/\?startapp=item_/);
    expect(crpl).not.toMatch(/\?startapp=item_/);
    expect(evnt).not.toMatch(/\?startapp=item_/);
  });
});
