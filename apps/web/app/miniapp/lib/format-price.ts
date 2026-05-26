// Pure price / time formatters extracted from MiniApp.tsx — F5.
// All helpers in this file are byte-stable copies of the originals; the
// behaviour is identical, only the location changed. No closure access, no
// React hooks — just `(input) => output`. Tested in format-price.test.ts.

import { t, localeToBCP47, type Locale } from '@wishlist/shared';

/**
 * Format an integer price for owner / guest item cards.
 * Returns null when the input is falsy (so callers can skip the row).
 *
 * Locale picks the thousands separator via BCP-47; currency suffix is the
 * ASCII glyph (RUB → ₽, USD → $). The space before the currency is
 * intentional (Russian typographic convention; same shape works in the
 * other locales we support).
 */
export const fmtPrice = (
  p: number | null,
  locale: Locale = 'ru',
  currency: 'RUB' | 'USD' = 'RUB',
): string | null => {
  if (!p) return null;
  const formatted = p.toLocaleString(localeToBCP47(locale));
  return currency === 'USD' ? `${formatted} $` : `${formatted} ₽`;
};

/** Format smart reservation remaining time as "Xd Xh" or "Xh Xm" or "Xm" */
export const formatSmartResTimer = (ms: number): string => {
  if (ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
};

/** Strip everything except digits from a user-facing price string. Returns raw digit string. */
export const parsePriceFromDisplay = (value: string): string =>
  value.replace(/\D/g, '');

/** Format a raw number/string as a thousands-separated display value (space as separator). */
export const formatPriceForDisplay = (
  value: number | string | null | undefined,
): string => {
  if (value === null || value === undefined || value === '') return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

/**
 * Human-readable retry-after string for rate-limit toasts.
 *
 * - Sub-minute → "now" copy
 * - < 1 h     → minutes copy
 * - < 24 h    → "Xh" or "Xh Ym" copy
 * - >= 24 h   → "tomorrow at HH:MM" copy (formatted in the user's locale)
 *
 * Uses `t()` for the locale-specific phrasing — still pure (no closures).
 */
export function formatRetryAfter(seconds: number, locale: Locale): string {
  if (seconds <= 0) return t('retry_now', locale);
  let hours = Math.floor(seconds / 3600);
  let minutes = Math.ceil((seconds % 3600) / 60);
  if (minutes >= 60) {
    hours += 1;
    minutes = 0;
  }
  if (hours === 0) return t('retry_minutes', locale, { minutes });
  if (hours < 24) {
    return minutes > 0
      ? t('retry_hours', locale, { hours, minutes })
      : t('retry_hours_only', locale, { hours });
  }
  const d = new Date(Date.now() + seconds * 1000);
  return t('retry_tomorrow', locale, {
    time: d.toLocaleTimeString(localeToBCP47(locale), {
      hour: '2-digit',
      minute: '2-digit',
    }),
  });
}
