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
//   item-open            — item_<itemId>
//   santa-preseason      — spsn_<seasonYear>
//   circle-join          — circ_<token>  (P0.1 «Близкие»; token, not a cuid)
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

export function buildItemOpenDeepLink(itemId: string): string {
  return `${getMiniAppUrl()}?startapp=item_${encodeURIComponent(itemId)}`;
}

/** E23 Santa pre-season teaser → opens the Mini App on the Santa hub and lets
 *  the client emit santa_preseason.dm_clicked. seasonYear is the canonical
 *  November-start year (digits only, no encoding needed). */
export function buildSantaPreseasonDeepLink(seasonYear: number): string {
  return `${getMiniAppUrl()}?startapp=spsn_${seasonYear}`;
}

// Circle invite / open link (P0.1 «Близкие»). The token is a random url-safe
// string (base64url), NOT a cuid — the frontend `circ_` parser validates the
// token shape, not `looksLikeId`. Used both as the shareable invite and as the
// owner's "open circle" notification button; the frontend opens the join
// preview, which renders an "Open circle" CTA when the viewer is already a member.
export function buildCircleDeepLink(token: string): string {
  return `${getMiniAppUrl()}?startapp=circ_${encodeURIComponent(token)}`;
}

// Shareable t.me invite link for a circle, posted into a family/friends chat.
// Unlike the web_app deep link above, this is a `t.me/<bot>?startapp=` URL so
// tapping it in any chat opens Telegram → bot → Mini App with the start param.
// Bot-username resolution mirrors referral.routes.ts.
function getBotUsername(): string {
  return process.env.TELEGRAM_BOT_USERNAME ?? process.env.NEXT_PUBLIC_BOT_USERNAME ?? 'WishHub_bot';
}

export function buildCircleShareLink(token: string): string {
  return `https://t.me/${getBotUsername()}?startapp=circ_${encodeURIComponent(token)}`;
}
