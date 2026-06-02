import { describe, it, expect } from 'vitest';
import { parseReservationReminderPayload, parseEventReminderPayload, parseSurveyInvitePayload, parseItemOpenPayload, parseSantaPreseasonPayload, parseCircleDetailPayload, parseCircleMemberPayload } from './startParam';

describe('parseReservationReminderPayload', () => {
  it('parses a well-formed rrem_<itemId>__m_<metaId> payload', () => {
    const result = parseReservationReminderPayload('rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx');
    expect(result).toEqual({ kind: 'ok', itemId: 'cmaa1bb2ccdd', reservationMetaId: 'cmm9zz8yyxx' });
  });

  it('rejects payloads whose decoded ids fail the cuid-shape regex', () => {
    // encodeURIComponent('id with space') === 'id%20with%20space'.
    // `decodeURIComponent` happily reproduces 'id with space', but the
    // strict regex rejects the space — guards against accepting payloads
    // that survive decode but aren't real cuids.
    const result = parseReservationReminderPayload('rrem_id%20with%20space__m_cmm9zz8yyxx');
    expect(result).toEqual({ kind: 'malformed' });
  });

  it('round-trips the wire format produced by buildReservationReminderDeepLink', () => {
    // Contract test — keeps the API helper's encode and the parser's decode
    // symmetric. Wire format documented in apps/api/src/telegram/deepLinks.ts
    // and replicated here to avoid a cross-package import in tests.
    const itemId = 'cmaa1bb2ccdd';
    const reservationMetaId = 'cmm9zz8yyxx';
    const wirePayload = `rrem_${encodeURIComponent(itemId)}__m_${encodeURIComponent(reservationMetaId)}`;
    expect(parseReservationReminderPayload(wirePayload)).toEqual({
      kind: 'ok', itemId, reservationMetaId,
    });
  });

  it('rejects payload without rrem_ prefix', () => {
    expect(parseReservationReminderPayload('crpl_a__c_b')).toEqual({ kind: 'malformed' });
    expect(parseReservationReminderPayload('foo')).toEqual({ kind: 'malformed' });
    expect(parseReservationReminderPayload('')).toEqual({ kind: 'malformed' });
  });

  it('rejects payload without __m_ separator', () => {
    expect(parseReservationReminderPayload('rrem_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
    expect(parseReservationReminderPayload('rrem_cmaa1bb2ccdd__c_cmm9zz8yyxx')).toEqual({ kind: 'malformed' });
  });

  it('rejects ids that fail the strict cuid-shape regex', () => {
    // Too short
    expect(parseReservationReminderPayload('rrem_short__m_cmm9zz8yyxx')).toEqual({ kind: 'malformed' });
    // Too long
    expect(parseReservationReminderPayload(`rrem_${'a'.repeat(50)}__m_cmm9zz8yyxx`)).toEqual({ kind: 'malformed' });
    // Forbidden character (`!`)
    expect(parseReservationReminderPayload('rrem_cmaa1bb2ccdd__m_cmm9zz!yyxx')).toEqual({ kind: 'malformed' });
  });

  it('does not throw on a malformed URI-encoded payload', () => {
    // Lone `%` is invalid for decodeURIComponent — must be caught and
    // surfaced as malformed, not bubble up as an exception.
    const result = parseReservationReminderPayload('rrem_cmaa1bb2ccdd__m_%E0%A4%A');
    expect(result).toEqual({ kind: 'malformed' });
  });

  it('does not match other deep-link payload prefixes', () => {
    // These are real shapes the in-app bootstrap dispatcher handles in
    // other branches — the helper must reject all of them so no parser
    // accidentally claims someone else's payload.
    for (const other of [
      'crpl_cmaa1bb2ccdd__c_cmcc3dd4eeff',
      'br_cmaa1bb2ccdd',
      'santa_join_token123',
      'gg_token123',
      'occasion_cmaa1bb2ccdd',
      'evnt_cmaa1bb2ccdd',
      'profile_someuser',
      'src_email__med_marketing',
      'cs_token123',
      'create_wishlist',
    ]) {
      expect(parseReservationReminderPayload(other)).toEqual({ kind: 'malformed' });
    }
  });
});

describe('parseEventReminderPayload', () => {
  it('parses a well-formed evnt_<occasionId> payload', () => {
    const result = parseEventReminderPayload('evnt_cmaa1bb2ccdd');
    expect(result).toEqual({ kind: 'ok', occasionId: 'cmaa1bb2ccdd' });
  });

  it('rejects payload without evnt_ prefix', () => {
    expect(parseEventReminderPayload('occasion_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
    expect(parseEventReminderPayload('rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx')).toEqual({ kind: 'malformed' });
    expect(parseEventReminderPayload('foo')).toEqual({ kind: 'malformed' });
    expect(parseEventReminderPayload('')).toEqual({ kind: 'malformed' });
  });

  it('rejects ids that fail the strict cuid-shape regex', () => {
    expect(parseEventReminderPayload('evnt_short')).toEqual({ kind: 'malformed' });
    expect(parseEventReminderPayload(`evnt_${'a'.repeat(50)}`)).toEqual({ kind: 'malformed' });
    expect(parseEventReminderPayload('evnt_cmaa1bb2c!dd')).toEqual({ kind: 'malformed' });
    // Decoded value is real but contains a space — strict regex rejects.
    expect(parseEventReminderPayload('evnt_id%20with%20space')).toEqual({ kind: 'malformed' });
  });

  it('does not throw on a malformed URI-encoded payload', () => {
    // Lone `%` is invalid for decodeURIComponent — must surface as
    // malformed, not bubble up as an exception.
    expect(parseEventReminderPayload('evnt_%E0%A4%A')).toEqual({ kind: 'malformed' });
  });

  it('round-trips the wire format produced by buildEventReminderDeepLink', () => {
    // Contract test — keeps the API helper's encode and the parser's decode
    // symmetric. Wire format documented in apps/api/src/telegram/deepLinks.ts.
    const occasionId = 'cmaa1bb2ccdd';
    const wirePayload = `evnt_${encodeURIComponent(occasionId)}`;
    expect(parseEventReminderPayload(wirePayload)).toEqual({ kind: 'ok', occasionId });
  });

  it('does not match other deep-link payload prefixes', () => {
    for (const other of [
      'crpl_cmaa1bb2ccdd__c_cmcc3dd4eeff',
      'rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx',
      'br_cmaa1bb2ccdd',
      'santa_join_token123',
      'gg_token123',
      'occasion_cmaa1bb2ccdd',
      'profile_someuser',
      'src_email__med_marketing',
      'cs_token123',
      'create_wishlist',
    ]) {
      expect(parseEventReminderPayload(other)).toEqual({ kind: 'malformed' });
    }
  });
});

describe('parseSurveyInvitePayload', () => {
  it('parses a well-formed srvy_<inviteId> payload', () => {
    const result = parseSurveyInvitePayload('srvy_cmaa1bb2ccdd');
    expect(result).toEqual({ kind: 'ok', inviteId: 'cmaa1bb2ccdd' });
  });

  it('round-trips the wire format produced by buildSurveyDeepLink', () => {
    const inviteId = 'cmaa1bb2ccdd';
    const wirePayload = `srvy_${encodeURIComponent(inviteId)}`;
    expect(parseSurveyInvitePayload(wirePayload)).toEqual({ kind: 'ok', inviteId });
  });

  it('rejects payload without srvy_ prefix', () => {
    expect(parseSurveyInvitePayload('rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx')).toEqual({ kind: 'malformed' });
    expect(parseSurveyInvitePayload('evnt_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
  });

  it('rejects payloads whose decoded id fails the cuid-shape regex', () => {
    expect(parseSurveyInvitePayload('srvy_id%20with%20space')).toEqual({ kind: 'malformed' });
    expect(parseSurveyInvitePayload('srvy_short')).toEqual({ kind: 'malformed' });
    expect(parseSurveyInvitePayload(`srvy_${'a'.repeat(50)}`)).toEqual({ kind: 'malformed' });
  });

  it('rejects undecodable percent-encoded payloads', () => {
    const result = parseSurveyInvitePayload('srvy_%E0%A4%A');
    expect(result).toEqual({ kind: 'malformed' });
  });
});

describe('parseItemOpenPayload', () => {
  it('parses a well-formed item_<itemId> payload', () => {
    const result = parseItemOpenPayload('item_cmaa1bb2ccdd');
    expect(result).toEqual({ kind: 'ok', itemId: 'cmaa1bb2ccdd' });
  });

  it('round-trips the wire format produced by buildItemOpenDeepLink', () => {
    // Contract test — keeps the API helper's encode and the parser's decode
    // symmetric. Wire format documented in apps/api/src/telegram/deepLinks.ts.
    const itemId = 'cmaa1bb2ccdd';
    const wirePayload = `item_${encodeURIComponent(itemId)}`;
    expect(parseItemOpenPayload(wirePayload)).toEqual({ kind: 'ok', itemId });
  });

  it('rejects payload without item_ prefix', () => {
    expect(parseItemOpenPayload('rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx')).toEqual({ kind: 'malformed' });
    expect(parseItemOpenPayload('evnt_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
    expect(parseItemOpenPayload('foo')).toEqual({ kind: 'malformed' });
    expect(parseItemOpenPayload('')).toEqual({ kind: 'malformed' });
  });

  it('rejects the legacy `<slug>__item_<id>` guest-share format', () => {
    // The legacy guest-share deep link is handled by a separate branch in
    // MiniApp.tsx (it loads `loadGuestWishlist(slug)` and looks for the item
    // in the public response). It must NOT be claimed by the item-open
    // parser, otherwise an authenticated owner clicking a shared link would
    // be silently routed through the authenticated `/tg/items/:id` lookup
    // instead of the public path — which would 403 if the slug is foreign.
    expect(parseItemOpenPayload('username_123__item_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
    // Edge case: payload starts with `item_` AND contains `__item_` — must
    // still be rejected so the malformed branch in MiniApp.tsx falls through
    // safely rather than half-routing.
    expect(parseItemOpenPayload('item_foo__item_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
  });

  it('rejects ids that fail the strict cuid-shape regex', () => {
    // Too short
    expect(parseItemOpenPayload('item_short')).toEqual({ kind: 'malformed' });
    // Too long
    expect(parseItemOpenPayload(`item_${'a'.repeat(50)}`)).toEqual({ kind: 'malformed' });
    // Forbidden character (`!`)
    expect(parseItemOpenPayload('item_cmaa1bb2c!dd')).toEqual({ kind: 'malformed' });
    // Decoded value is real but contains a space — strict regex rejects.
    expect(parseItemOpenPayload('item_id%20with%20space')).toEqual({ kind: 'malformed' });
  });

  it('does not throw on a malformed URI-encoded payload', () => {
    // Lone `%` is invalid for decodeURIComponent — must surface as
    // malformed, not bubble up as an exception.
    expect(parseItemOpenPayload('item_%E0%A4%A')).toEqual({ kind: 'malformed' });
  });

  it('does not match other deep-link payload prefixes', () => {
    for (const other of [
      'crpl_cmaa1bb2ccdd__c_cmcc3dd4eeff',
      'rrem_cmaa1bb2ccdd__m_cmm9zz8yyxx',
      'evnt_cmaa1bb2ccdd',
      'srvy_cmaa1bb2ccdd',
      'br_cmaa1bb2ccdd',
      'santa_join_token123',
      'gg_token123',
      'occasion_cmaa1bb2ccdd',
      'profile_someuser',
      'src_email__med_marketing',
      'cs_token123',
      'create_wishlist',
    ]) {
      expect(parseItemOpenPayload(other)).toEqual({ kind: 'malformed' });
    }
  });
});

describe('parseSantaPreseasonPayload', () => {
  it('parses a well-formed spsn_<seasonYear> payload to a number', () => {
    expect(parseSantaPreseasonPayload('spsn_2026')).toEqual({ kind: 'ok', seasonYear: 2026 });
  });

  it('round-trips the wire format produced by buildSantaPreseasonDeepLink', () => {
    // Contract test — symmetric with apps/api/src/telegram/deepLinks.ts.
    const seasonYear = 2026;
    expect(parseSantaPreseasonPayload(`spsn_${seasonYear}`)).toEqual({ kind: 'ok', seasonYear });
  });

  it('rejects payloads without the spsn_ prefix', () => {
    expect(parseSantaPreseasonPayload('santa_join_token123')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('srvy_cmaa1bb2ccdd')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('foo')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('')).toEqual({ kind: 'malformed' });
  });

  it('rejects a non-4-digit season (the strict \\d{4} guard)', () => {
    expect(parseSantaPreseasonPayload('spsn_')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('spsn_202')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('spsn_20260')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('spsn_20a6')).toEqual({ kind: 'malformed' });
    expect(parseSantaPreseasonPayload('spsn_ 026')).toEqual({ kind: 'malformed' });
  });
});

// P0.3 «Событийные пуши» deep-link parsers — symmetric with
// apps/api/src/telegram/deepLinks.ts buildCircleDetailDeepLink / buildCircleMemberDeepLink.
describe('parseCircleDetailPayload', () => {
  it('parses a well-formed circd_<circleId> payload', () => {
    expect(parseCircleDetailPayload('circd_clh2x9abc000d1234567890')).toEqual({ kind: 'ok', circleId: 'clh2x9abc000d1234567890' });
  });
  it('does NOT collide with the circ_ invite prefix', () => {
    // 'circ_<token>' must not be misread as a detail link (different parser).
    expect(parseCircleDetailPayload('circ_AbC123_def-XYZ')).toEqual({ kind: 'malformed' });
  });
  it('rejects a non-cuid circleId and missing prefix', () => {
    expect(parseCircleDetailPayload('circd_short')).toEqual({ kind: 'malformed' });
    expect(parseCircleDetailPayload('foo_clh2x9abc000d1234567890')).toEqual({ kind: 'malformed' });
    expect(parseCircleDetailPayload('')).toEqual({ kind: 'malformed' });
  });
});

describe('parseCircleMemberPayload', () => {
  it('parses circm_<circleId>__u_<memberId>', () => {
    expect(parseCircleMemberPayload('circm_clh2x9abc000d1234567890__u_clm3y8def000e0987654321')).toEqual({
      kind: 'ok',
      circleId: 'clh2x9abc000d1234567890',
      memberId: 'clm3y8def000e0987654321',
    });
  });
  it('rejects when the __u_ separator is missing', () => {
    expect(parseCircleMemberPayload('circm_clh2x9abc000d1234567890')).toEqual({ kind: 'malformed' });
  });
  it('rejects when either id is not a cuid', () => {
    expect(parseCircleMemberPayload('circm_short__u_clm3y8def000e0987654321')).toEqual({ kind: 'malformed' });
    expect(parseCircleMemberPayload('circm_clh2x9abc000d1234567890__u_x')).toEqual({ kind: 'malformed' });
  });
  it('rejects a missing circm_ prefix', () => {
    expect(parseCircleMemberPayload('circd_clh2x9abc000d1234567890')).toEqual({ kind: 'malformed' });
  });
});
