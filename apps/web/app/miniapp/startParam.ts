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
//   event-reminder       — evnt_<occasionId>
//   research-survey      — srvy_<inviteId>
//   item-open            — item_<itemId>
//   santa-preseason      — spsn_<seasonYear>
//   circle-join          — circ_<token>  (P0.1 «Близкие»; token, not a cuid)

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

export type EventReminderPayload =
  | { kind: 'ok'; occasionId: string }
  | { kind: 'malformed' };

export function parseEventReminderPayload(payload: string): EventReminderPayload {
  if (!payload.startsWith('evnt_')) return { kind: 'malformed' };

  let occasionId: string;
  try {
    occasionId = decodeURIComponent(payload.slice('evnt_'.length));
  } catch {
    return { kind: 'malformed' };
  }

  if (!looksLikeId(occasionId)) return { kind: 'malformed' };
  return { kind: 'ok', occasionId };
}

export type SurveyInvitePayload =
  | { kind: 'ok'; inviteId: string }
  | { kind: 'malformed' };

export function parseSurveyInvitePayload(payload: string): SurveyInvitePayload {
  if (!payload.startsWith('srvy_')) return { kind: 'malformed' };

  let inviteId: string;
  try {
    inviteId = decodeURIComponent(payload.slice('srvy_'.length));
  } catch {
    return { kind: 'malformed' };
  }

  if (!looksLikeId(inviteId)) return { kind: 'malformed' };
  return { kind: 'ok', inviteId };
}

export type ItemOpenPayload =
  | { kind: 'ok'; itemId: string }
  | { kind: 'malformed' };

// Critical: must NOT match the legacy `<slug>__item_<id>` guest-share format
// (handled by a separate branch in MiniApp.tsx). That format contains
// `__item_` in the middle of the string; this one starts with `item_` at
// position 0. The `startsWith` + double-underscore check makes the two
// mutually exclusive.
export function parseItemOpenPayload(payload: string): ItemOpenPayload {
  if (!payload.startsWith('item_')) return { kind: 'malformed' };
  // Guard against the legacy `<slug>__item_<id>` shape where the payload
  // would technically pass startsWith only if the slug is empty (which the
  // bootstrap already filters earlier), but the double-underscore separator
  // is a defining marker. Reject defensively.
  if (payload.includes('__item_')) return { kind: 'malformed' };

  let itemId: string;
  try {
    itemId = decodeURIComponent(payload.slice('item_'.length));
  } catch {
    return { kind: 'malformed' };
  }

  if (!looksLikeId(itemId)) return { kind: 'malformed' };
  return { kind: 'ok', itemId };
}

export type SantaPreseasonPayload =
  | { kind: 'ok'; seasonYear: number }
  | { kind: 'malformed' };

// E23 pre-season teaser deep link — `spsn_<seasonYear>`. seasonYear is the
// canonical November-start year (4 digits). Routes the Mini App to the Santa
// hub and lets the client emit santa_preseason.dm_clicked. Symmetric with
// apps/api/src/telegram/deepLinks.ts::buildSantaPreseasonDeepLink.
export function parseSantaPreseasonPayload(payload: string): SantaPreseasonPayload {
  if (!payload.startsWith('spsn_')) return { kind: 'malformed' };
  const rest = payload.slice('spsn_'.length);
  if (!/^\d{4}$/.test(rest)) return { kind: 'malformed' };
  return { kind: 'ok', seasonYear: Number.parseInt(rest, 10) };
}

export type CircleInvitePayload =
  | { kind: 'ok'; token: string }
  | { kind: 'malformed' };

// circ_<token> — P0.1 «Близкие». The token is a url-safe base64url string
// (NOT a cuid), so it uses a token-shape guard rather than `looksLikeId`.
// Symmetric with apps/api/src/telegram/deepLinks.ts `buildCircleShareLink`.
export function parseCircleInvitePayload(payload: string): CircleInvitePayload {
  if (!payload.startsWith('circ_')) return { kind: 'malformed' };
  let token: string;
  try {
    token = decodeURIComponent(payload.slice('circ_'.length));
  } catch {
    return { kind: 'malformed' };
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return { kind: 'malformed' };
  return { kind: 'ok', token };
}

export type CircleDetailPayload =
  | { kind: 'ok'; circleId: string }
  | { kind: 'malformed' };

// circd_<circleId> — P0.3 event push → open a circle's detail. The recipient is
// already a member (that's why they got the push), so it addresses the circle
// by id (a cuid), validated with `looksLikeId`. Symmetric with
// apps/api/src/telegram/deepLinks.ts `buildCircleDetailDeepLink`.
export function parseCircleDetailPayload(payload: string): CircleDetailPayload {
  if (!payload.startsWith('circd_')) return { kind: 'malformed' };
  let circleId: string;
  try {
    circleId = decodeURIComponent(payload.slice('circd_'.length));
  } catch {
    return { kind: 'malformed' };
  }
  if (!looksLikeId(circleId)) return { kind: 'malformed' };
  return { kind: 'ok', circleId };
}

export type CircleMemberPayload =
  | { kind: 'ok'; circleId: string; memberId: string }
  | { kind: 'malformed' };

// circm_<circleId>__u_<memberId> — P0.3 event push → open a member's lists
// inside a circle (new-wish / upcoming-event pushes). Both ids are cuids.
// Symmetric with apps/api/src/telegram/deepLinks.ts `buildCircleMemberDeepLink`.
export function parseCircleMemberPayload(payload: string): CircleMemberPayload {
  if (!payload.startsWith('circm_')) return { kind: 'malformed' };
  const rest = payload.slice('circm_'.length);
  const sepIdx = rest.indexOf('__u_');
  if (sepIdx < 0) return { kind: 'malformed' };
  let circleId: string;
  let memberId: string;
  try {
    circleId = decodeURIComponent(rest.slice(0, sepIdx));
    memberId = decodeURIComponent(rest.slice(sepIdx + '__u_'.length));
  } catch {
    return { kind: 'malformed' };
  }
  if (!looksLikeId(circleId) || !looksLikeId(memberId)) return { kind: 'malformed' };
  return { kind: 'ok', circleId, memberId };
}
