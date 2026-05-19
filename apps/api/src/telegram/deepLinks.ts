// Telegram Mini App deep links.
//
// Helpers produce `startapp` payloads in the exact wire format that the
// MiniApp.tsx bootstrap parser expects. The encoder side runs
// `encodeURIComponent` on each id segment; the parser side runs
// `decodeURIComponent` symmetrically and then enforces a strict cuid-shape
// check (`looksLikeId`). The encoder is permissive (anything URI-safe goes);
// the parser rejects anything that doesn't look like a cuid even if it
// round-trips cleanly through encode/decode. That asymmetry is intentional —
// it keeps forged or accidentally-malformed payloads from escaping into the
// app router.
//
// Wire formats:
//   comment-reply        — crpl_<itemId>__c_<commentId>
//   reservation-reminder — rrem_<itemId>__m_<reservationMetaId>
//   event-reminder       — evnt_<occasionId>
//   research-survey      — srvy_<inviteId>
//
// MINI_APP_URL fallback chain matches every other call site in index.ts:
//   1. process.env.MINI_APP_URL (preferred, set in prod)
//   2. process.env.WEB_ORIGIN + '/miniapp'
//   3. https://wishlistik.ru/miniapp (final fallback)
// All env reads happen at call time, not module load.

function getMiniAppUrl(): string {
  return process.env.MINI_APP_URL
    ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');
}

export function buildCommentReplyDeepLink(itemId: string, commentId: string): string {
  return `${getMiniAppUrl()}?startapp=crpl_${encodeURIComponent(itemId)}__c_${encodeURIComponent(commentId)}`;
}

export function buildReservationReminderDeepLink(itemId: string, reservationMetaId: string): string {
  return `${getMiniAppUrl()}?startapp=rrem_${encodeURIComponent(itemId)}__m_${encodeURIComponent(reservationMetaId)}`;
}

export function buildEventReminderDeepLink(occasionId: string): string {
  return `${getMiniAppUrl()}?startapp=evnt_${encodeURIComponent(occasionId)}`;
}

export function buildSurveyDeepLink(inviteId: string): string {
  return `${getMiniAppUrl()}?startapp=srvy_${encodeURIComponent(inviteId)}`;
}
