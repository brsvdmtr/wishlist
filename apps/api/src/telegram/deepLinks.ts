// Telegram Mini App deep links.
//
// `buildCommentReplyDeepLink` produces the exact `startapp` query string the
// MiniApp.tsx bootstrap parser expects:
//   crpl_<itemId>__c_<commentId>
// Encoding is kept identical (encodeURIComponent on each id segment) — the
// Mini App parser uses decodeURIComponent symmetrically.
//
// MINI_APP_URL fallback chain matches every other call site in index.ts:
//   1. process.env.MINI_APP_URL (preferred, set in prod)
//   2. process.env.WEB_ORIGIN + '/miniapp'
//   3. https://wishlistik.ru/miniapp (final fallback)
// All env reads happen at call time, not module load.

export function buildCommentReplyDeepLink(itemId: string, commentId: string): string {
  const miniAppUrl = process.env.MINI_APP_URL ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');
  return `${miniAppUrl}?startapp=crpl_${encodeURIComponent(itemId)}__c_${encodeURIComponent(commentId)}`;
}
