import React, { type CSSProperties } from 'react';
import { colors, shadows, radius } from '@wishlist/ui-tokens';

/**
 * @status provisional — top-right counter circle for tab-bar badges,
 * notification indicators, chip counters.
 *
 * Source: approved `v2-home-all-tabs.html` (counter-badge "5" on
 * Брони tab). Codified 2026-04-19 as the non-inline notification pattern.
 *
 * MUST be placed inside a `position: relative` parent. Defaults to
 * `position: absolute; top: -6px; right: -6px`.
 */
export interface CounterBadgeProps {
  count: number;
  /** Show zero. Default `false` — zero hides the badge. */
  showZero?: boolean;
  /** Cap display at `max` (shows `max+`). Default 99. */
  max?: number;
  /** Tone: `danger` (red, default) / `accent` / `success` / `warning`. */
  tone?: 'danger' | 'accent' | 'success' | 'warning';
  /** Size variant. Default `md` (20px). */
  size?: 'sm' | 'md';
  /** Border-blend to parent bg. Default `colors.bg`. Pass `'transparent'` to skip. */
  borderColor?: string;
  style?: CSSProperties;
}

const toneBg: Record<NonNullable<CounterBadgeProps['tone']>, string> = {
  danger: colors.danger,
  accent: colors.accent,
  success: colors.success,
  warning: colors.warning,
};

const toneShadow: Record<NonNullable<CounterBadgeProps['tone']>, string> = {
  danger: shadows.notificationDanger,
  accent: shadows.notificationAccent,
  success: '0 2px 6px rgba(52,211,153,0.4)',
  warning: '0 2px 6px rgba(251,191,36,0.4)',
};

export function CounterBadge({
  count,
  showZero = false,
  max = 99,
  tone = 'danger',
  size = 'md',
  borderColor = colors.bg,
  style,
}: CounterBadgeProps) {
  if (count <= 0 && !showZero) return null;

  const dim = size === 'sm' ? 16 : 20;
  const fontSize = size === 'sm' ? 9 : 10;
  const displayCount = count > max ? `${max}+` : String(count);
  const textColor = tone === 'warning' ? '#000' : colors.white;

  return (
    <span
      aria-label={`${count} new`}
      style={{
        position: 'absolute',
        top: -6,
        right: -6,
        background: toneBg[tone],
        color: textColor,
        fontSize,
        fontWeight: 800,
        minWidth: dim,
        height: dim,
        padding: '0 5px',
        borderRadius: radius.circle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        border: borderColor === 'transparent' ? undefined : `2px solid ${borderColor}`,
        boxShadow: toneShadow[tone],
        letterSpacing: 0,
        pointerEvents: 'none',
        ...style,
      }}
    >
      {displayCount}
    </span>
  );
}
