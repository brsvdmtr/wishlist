import { z } from 'zod';

export * from './analyticsEvents';
export * from './sanitizeAnalyticsProps';
export * from './i18n';

export const WishlistItemSchema = z.object({
  title: z.string().min(1),
  url: z.string().url().optional(),
  note: z.string().max(2000).optional(),
});

export type WishlistItemInput = z.infer<typeof WishlistItemSchema>;

// ─── Pro Lifetime — cross-package shared constants ───────────────────────────
// Lifetime is a permanent Pro tier (one-time Telegram Stars purchase). The
// `Subscription.billingPeriod` discriminator is the canonical truth signal —
// resolvers, schedulers, and UI compare against `LIFETIME_BILLING_PERIOD`
// rather than against the sentinel date. The 2099-12-31 sentinel below is
// defensive padding so the expiry-sweep cron can't race a clock skew.
//
// Both apps/api and apps/bot import these — keeping them in @wishlist/shared
// avoids cross-app duplication that drifts silently.

/** Sentinel value for `Subscription.billingPeriod` denoting permanent Pro. */
export const LIFETIME_BILLING_PERIOD = 'lifetime' as const;

/** ISO sentinel for `Subscription.currentPeriodEnd` on a lifetime row. Far
 * enough future that no expiry-sweep query window will catch it; both
 * apps/api/services/entitlement.ts and apps/bot/successful_payment use this
 * exact string to construct the Date so the values never drift. */
export const PRO_LIFETIME_PERIOD_END_ISO = '2099-12-31T00:00:00.000Z';

/** Returns true if the given subscription row represents a lifetime Pro grant. */
export function isLifetimeSubscription(
  sub: { billingPeriod?: string | null } | null | undefined,
): boolean {
  return !!sub && sub.billingPeriod === LIFETIME_BILLING_PERIOD;
}

// ─── Share / Deep Link helpers ───────────────────────────

/**
 * Build a Telegram deep link that opens the Mini App directly.
 * Format: https://t.me/<BOT>?startapp=<payload>
 */
export function buildTgDeepLink(botUsername: string, payload?: string): string | null {
  if (!botUsername) return null;
  const base = `https://t.me/${botUsername}`;
  return payload ? `${base}?startapp=${encodeURIComponent(payload)}` : base;
}

/**
 * Build a Telegram share URL that opens the native chat picker.
 * Format: https://t.me/share/url?url=<URL>&text=<TEXT>
 */
export function buildTgShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

// ─── Hints idempotency / lookup window ──────────────────────────────────────
//
// Producer (apps/api/src/routes/hints.routes.ts POST /tg/items/:id/hint) and
// consumer (apps/bot/src/index.ts users_shared handler) synchronise through
// the Hint row in Postgres. Both sides query "most recent SENT hint within
// the last N minutes" — if those Ns drift, the consumer fails to find a
// hint the producer just created (or considers idempotent), and the user
// sees "Активный намёк не найден" on a fresh keyboard.
//
// 2026-05-03 prod bug: API used a 30-day idempotency window (the
// `Hint.expiresAt` field) while bot used 30 min. A re-tap after a few hours
// got the same 10-hour-old hintId from API, bot couldn't find it within
// 30 min, hard-rejected. Window mismatch was masked for weeks by network
// outages that prevented producer/consumer from talking reliably.
//
// Rule: any window that producer + consumer must agree on is ONE constant
// imported by both. Magic numbers in `findFirst` are forbidden here —
// they drift silently.
export const HINT_LOOKUP_WINDOW_MS = 30 * 60 * 1000;
