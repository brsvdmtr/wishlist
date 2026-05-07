// Pure parsers for Telegram Mini App `startapp` payloads.
//
// Each parser is a small total function: it returns a discriminated union
// describing what was found, never throws, and validates ids against the
// same regex used by every other deep-link parser in the bootstrap.
// Extracting these makes the bootstrap branches in MiniApp.tsx testable
// without dragging in the full React/Telegram runtime.
//
// Wire formats (must stay symmetric with apps/api/src/telegram/deepLinks.ts):
//   comment-reply        — crpl_<itemId>__c_<commentId>
//   reservation-reminder — rrem_<itemId>__m_<reservationMetaId>

// Cuid-shape guard reused by every deep-link parser. cuids are
// `^[a-z0-9]{20,30}$` in practice, but the looser regex below also accepts
// the legacy short ids and `_-` characters that have appeared in test
// fixtures and migration data.
export const looksLikeId = (s: string): boolean => /^[a-z0-9_-]{10,40}$/i.test(s);

export type ReservationReminderPayload =
  | { kind: 'ok'; itemId: string; reservationMetaId: string }
  | { kind: 'malformed' };

export function parseReservationReminderPayload(payload: string): ReservationReminderPayload {
  if (!payload.startsWith('rrem_')) return { kind: 'malformed' };
  const rest = payload.slice('rrem_'.length);
  const sepIdx = rest.indexOf('__m_');
  if (sepIdx < 0) return { kind: 'malformed' };

  // Mirror the API helper: ids are encodeURIComponent'd on the server side.
  let itemId: string;
  let reservationMetaId: string;
  try {
    itemId = decodeURIComponent(rest.slice(0, sepIdx));
    reservationMetaId = decodeURIComponent(rest.slice(sepIdx + '__m_'.length));
  } catch {
    return { kind: 'malformed' };
  }

  if (!looksLikeId(itemId) || !looksLikeId(reservationMetaId)) {
    return { kind: 'malformed' };
  }
  return { kind: 'ok', itemId, reservationMetaId };
}
