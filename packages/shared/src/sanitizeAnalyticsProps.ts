// Defense-in-depth sanitizer for `AnalyticsEvent.props`.
//
// Every analytics helper — and the POST /tg/telemetry client-ingest route —
// runs props through this helper before persistence:
//   - apps/api/src/services/analytics.ts      — trackEvent / trackAnalyticsEvent
//                                                / trackProductEvent
//   - apps/api/src/routes/telemetry.routes.ts  — POST /tg/telemetry ingest
//   - apps/bot/src/analytics.ts                — trackProductEvent / _rawEmit
//
// NOT covered, by deliberate scoping (docs/research/analytics-pii-audit.md §5):
// the direct `prisma.analyticsEvent.create` calls in apps/api/src/index.ts
// (error-rate middleware — writes no `props` at all) and the four direct
// calls in apps/bot/src/index.ts (`bot.start_received` + three `referral.*`
// events). The bot calls write only non-free-text fields — ids, enums,
// booleans, and `startParam` (the Telegram-format-constrained `?start=`
// deep-link token: bounded length, [A-Za-z0-9_-], not free text). No user
// free text reaches those paths.
//
// It does two things:
//
//   1. Drops keys carrying user-generated free text — item titles and
//      descriptions, comment / hint bodies, search queries, freeform notes,
//      person names. Analytics needs counts and shapes, never the content.
//      The AnalyticsEvent table has a 90-day TTL, no encryption, and is
//      queried ad-hoc in god-mode — keeping user content out of it is a
//      compliance requirement, not a nicety. See
//      docs/research/analytics-pii-audit.md.
//
//   2. Truncates oversized string values (per-string cap) and enforces a
//      total serialized-size cap — logic previously copy-pasted inline in
//      four separate places.
//
// PII stripping is a NAME denylist, matched case-insensitively against each
// top-level prop key. It is intentionally a denylist, not an allowlist: a new
// event that invents a new freeform-content key is NOT caught until that key
// is added to `ANALYTICS_PII_PROP_KEYS`. The companion test pins the
// contract; the audit doc carries the adoption rule.
//
// Limitation: only TOP-LEVEL keys are inspected. Analytics props are flat by
// convention — nested objects pass through untouched, so do not nest user
// content inside an analytics prop.

/** Per-string length cap. Longer string values are sliced + '...'-suffixed. */
export const ANALYTICS_PROP_MAX_STRING_LEN = 300;

/**
 * Total serialized-length cap — `JSON.stringify(...).length`, i.e. UTF-16
 * code units, NOT bytes. Over this, props collapse to `{ _truncated: true }`.
 * Don't size a DB column off this constant.
 */
export const ANALYTICS_PROPS_MAX_SERIALIZED_LEN = 1024;

/**
 * Prop keys whose values are user-generated free text. Compared
 * case-insensitively against each top-level prop key; a match drops the key
 * entirely. Keep entries lowercase, grouped by content category.
 *
 * Booleans / lengths / hashes derived from user content (`hasText`,
 * `titleLength`, `normalizedQueryHash`) are NOT here and are intentionally
 * kept — they are the privacy-safe shape signals analytics is allowed to use.
 */
export const ANALYTICS_PII_PROP_KEYS: ReadonlySet<string> = new Set<string>([
  // item / wishlist content
  'title', 'itemtitle', 'wishtitle', 'wishlisttitle', 'newtitle',
  'description', 'desc', 'itemdescription', 'newdescription',
  // comments
  'comment', 'commenttext', 'commentbody', 'replytext',
  // hints
  'hint', 'hinttext', 'hintmessage',
  // search
  'query', 'searchquery', 'searchtext', 'rawquery', 'searchterm',
  // freeform notes / messages / captions / bios / generic free text
  'text', 'body', 'message', 'custommessage', 'note', 'notes', 'adminnote',
  'giftnote', 'giftnotetext', 'answertext', 'bio', 'caption', 'feedback',
  'content', 'input', 'subject', 'summary',
  // person names + contact / location PII
  'name', 'firstname', 'lastname', 'fullname', 'displayname',
  'address', 'city',
]);

/**
 * Strip user-content keys and truncate oversized values from an analytics
 * props object. Pure — never mutates the input.
 *
 * @returns the cleaned props, or `undefined` when the input is null/undefined.
 *   When the cleaned object still serializes over the total size cap, returns
 *   `{ _truncated: true }`.
 */
export function sanitizeAnalyticsProps(
  props: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!props) return undefined;

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    // Drop PII keys outright — analytics never needs the raw content.
    if (ANALYTICS_PII_PROP_KEYS.has(key.toLowerCase())) continue;
    // Per-value cap applies to strings only. Non-string values (arrays,
    // nested objects) are not truncated individually — they rely on the
    // total serialized-size cap below as the backstop.
    cleaned[key] =
      typeof value === 'string' && value.length > ANALYTICS_PROP_MAX_STRING_LEN
        ? value.slice(0, ANALYTICS_PROP_MAX_STRING_LEN) + '...'
        : value;
  }

  // Total-size cap. JSON.stringify throws on circular references and BigInt
  // values — analytics props should never contain those, but this helper is
  // a defensive layer and must never throw into its (fire-and-forget) callers,
  // so a non-serializable props object collapses to the truncation marker.
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    return { _truncated: true };
  }
  if (serialized.length > ANALYTICS_PROPS_MAX_SERIALIZED_LEN) {
    return { _truncated: true };
  }
  return cleaned;
}
