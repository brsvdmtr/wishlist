import React, { type ReactNode, type HTMLAttributes, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, spacingSemantic, transition, gradients } from '@wishlist/ui-tokens';

/**
 * @status per-variant:
 *   - `card` → **canonical** (2026-04-20, 5 call-sites + 3 states validated)
 *   - `compact` / `plain` → `provisional`
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-20--listrow-wave-1-adoption--card-variant-promoted-to-canonical`.
 * State-tint contract codified in `mockups/approved/v2-wish-state-matrix.html`.
 */
export type ListRowVariant = 'card' | 'compact' | 'plain';

/**
 * Canonical **state** tint per approved state-matrix:
 * - `neutral` — no tint (default, available items)
 * - `current` — accent-tint (active/selected)
 * - `reservedByMe` — success-tint (publicly reserved by viewer)
 * - `secret` — accent-tint + secret marker (secret-reservation cards)
 * - `warning` — warning-tint (expiring / item updated)
 * - `conflict` — danger-tint (public-reserved-by-other conflict)
 * - `muted` — opacity 0.55 (someone else reserved; can't act)
 * - `done` — opacity 0.45 + strike (purchased/completed/deleted)
 */
export type ListRowState =
  | 'neutral'
  | 'current'
  | 'reservedByMe'
  | 'secret'
  | 'warning'
  | 'conflict'
  | 'muted'
  | 'done';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  variant?: ListRowVariant;
  state?: ListRowState;
  /** Leading slot — thumbnail, avatar, icon. */
  leading?: ReactNode;
  /** Trailing slot — chevron, badge, action button. */
  trailing?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional meta row below subtitle (price, timestamp, chips). */
  meta?: ReactNode;
  /** Adds cursor:pointer + hover transition. */
  interactive?: boolean;
}

const variantStyles: Record<ListRowVariant, CSSProperties> = {
  card: {
    borderRadius: radius.xl,
    padding: spacingSemantic.listRowPadding,
    gap: spacingSemantic.listRowGap,
  },
  compact: {
    borderRadius: radius.xl,
    padding: `${spacingSemantic.listRowPaddingCompactY}px ${spacingSemantic.listRowPaddingCompactX}px`,
    gap: 12,
  },
  plain: {
    background: colors.transparent,
    border: 'none',
    padding: '14px 0',
    gap: 12,
  },
};

const stateStyles: Record<ListRowState, CSSProperties> = {
  neutral: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
  },
  current: {
    background: gradients.accentStateTint,
    border: '1px solid rgba(124,106,255,0.3)',
    boxShadow: '0 0 0 1px rgba(124,106,255,0.15) inset, 0 4px 16px rgba(124,106,255,0.08)',
  },
  reservedByMe: {
    background: gradients.successStateTint,
    border: '1px solid rgba(52,211,153,0.25)',
  },
  secret: {
    background: 'linear-gradient(135deg, #2F2F38, rgba(124,106,255,0.06))',
    border: '1px solid rgba(124,106,255,0.3)',
  },
  warning: {
    background: gradients.warningStateTint,
    border: '1px solid rgba(251,191,36,0.35)',
  },
  conflict: {
    background: gradients.dangerStateTint,
    border: '1px solid rgba(248,113,113,0.35)',
  },
  muted: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    opacity: 0.55,
  },
  done: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    opacity: 0.45,
  },
};

export function ListRow({
  variant = 'card',
  state = 'neutral',
  leading,
  trailing,
  title,
  subtitle,
  meta,
  interactive,
  style,
  ...rest
}: ListRowProps) {
  const isStrikeTitle = state === 'done';
  const titleColor = state === 'muted' || state === 'done' ? colors.textMuted : colors.text;
  const variantStyle = variantStyles[variant];
  const stateStyle = variant === 'plain' ? {} : stateStyles[state];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        ...variantStyle,
        ...stateStyle,
        cursor: interactive ? 'pointer' : undefined,
        transition: interactive ? transition.all : undefined,
        ...style,
      }}
      {...rest}
    >
      {leading && <div style={{ flexShrink: 0 }}>{leading}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: fontSize.lg,
            fontWeight: fontWeight.semibold,
            color: titleColor,
            textDecoration: isStrikeTitle ? 'line-through' : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2 as never,
            WebkitBoxOrient: 'vertical' as never,
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: fontSize.base,
              color: colors.textSecondary,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2 as never,
              WebkitBoxOrient: 'vertical' as never,
            }}
          >
            {subtitle}
          </div>
        )}
        {meta && <div style={{ marginTop: 6 }}>{meta}</div>}
      </div>
      {trailing && <div style={{ flexShrink: 0, alignSelf: 'center' }}>{trailing}</div>}
    </div>
  );
}
