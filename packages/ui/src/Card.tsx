import React, { forwardRef, type HTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { colors, radius, spacingSemantic, transition, shadows, gradients } from '@wishlist/ui-tokens';

/**
 * @status per-variant:
 *   - `default` / `interactive` → **canonical** (2026-04-19, 5 live call-sites)
 *   - `hero` → **canonical** (2026-04-20, paywall hero — hero-class primitives
 *     are inherently 1-per-surface; contract validated against canonical tokens)
 *   - `flat` / `current` → `provisional`
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-20--paywall-b-full-full-redesign-to-match-approved-v2-paywall.html--yearly-pro-plan`.
 */
export type CardVariant =
  | 'default'
  | 'flat'
  | 'interactive'
  | /** Accent-tinted "this is active / current" card. Subtle accent border + inset ring. */ 'current'
  | /** Premium hero — paywall / showcase. Uses `gradients.paywallHero` + deep shadow by default, override via style. */ 'hero';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
  children?: ReactNode;
}

const paddingMap: Record<CardPadding, number> = {
  none: 0,
  sm: 12,
  md: spacingSemantic.cardPadding, // 16
  lg: 20,
};

const variantStyles: Record<CardVariant, CSSProperties> = {
  default: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.xl,
  },
  flat: {
    background: colors.surface,
    border: 'none',
    borderRadius: radius.xl,
  },
  interactive: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.xl,
    cursor: 'pointer',
    transition: transition.all,
  },
  current: {
    background: gradients.accentStateTint,
    border: '1px solid rgba(124,106,255,0.3)',
    borderRadius: radius.xl,
    boxShadow: '0 0 0 1px rgba(124,106,255,0.15) inset, 0 4px 16px rgba(124,106,255,0.08)',
  },
  hero: {
    background: gradients.paywallHero,
    color: colors.white,
    borderRadius: radius.xxxl,
    boxShadow: shadows.paywallHero,
    border: 'none',
  },
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = 'default', padding = 'md', style, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      style={{
        padding: paddingMap[padding],
        ...variantStyles[variant],
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
});
