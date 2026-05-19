import { describe, it, expect } from 'vitest';
import { parseReservationReminderPayload, parseEventReminderPayload, parseSurveyInvitePayload } from './startParam';

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
