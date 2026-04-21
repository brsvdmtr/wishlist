import React, { forwardRef, type HTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { colors, radius, spacingSemantic, transition, shadows, gradients } from '@wishlist/ui-tokens';

/**
 * @status v2.1 refresh — translucent glass surfaces. All variants read CSS
 * vars set by `ThemeProvider` (`var(--wb-card, ...)`); fallback to TS tokens
 * when rendered outside a theme-provider scope.
 *
 * Per-variant status (post-refresh):
 *   - `default` / `interactive` → **canonical** (inherited from v2 promotion)
 *   - `hero` → **canonical** (layered gradient + composed shadow)
 *   - `current` → **canonical** (accent-tinted modifier)
 *   - `glass` → `provisional` (v2.1-new: borderless translucent tile)
 *   - `flat` → `provisional` (0 adoptions; drift candidate)
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-21--v21-refresh-approved-as-new-visual-direction-glass--mesh--theme-system`.
 */
export type CardVariant =
  | 'default'
  | 'flat'
  | 'interactive'
  | /** Accent-tinted "this is active / current" card. Subtle accent border + inset ring. */ 'current'
  | /** Premium hero — paywall / showcase. Uses layered accent gradient + `shadows.paywallHero`. */ 'hero'
  | /** Borderless translucent tile — settings groups, inner cards inside sheets. */ 'glass';

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

/** Glass composition — applied to all translucent variants for consistent blur. */
const glassBase: CSSProperties = {
  WebkitBackdropFilter: 'blur(16px)' as never,
  backdropFilter: 'blur(16px)' as never,
};

const variantStyles: Record<CardVariant, CSSProperties> = {
  default: {
    ...glassBase,
    background: `var(--wb-card, ${colors.card})`,
    border: `1px solid var(--wb-border, ${colors.border})`,
    borderRadius: radius.xxl,
  },
  flat: {
    background: `var(--wb-surface, ${colors.surface})`,
    border: 'none',
    borderRadius: radius.xxl,
  },
  interactive: {
    ...glassBase,
    background: `var(--wb-card, ${colors.card})`,
    border: `1px solid var(--wb-border, ${colors.border})`,
    borderRadius: radius.xxl,
    cursor: 'pointer',
    transition: transition.allEmph,
  },
  current: {
    ...glassBase,
    background: gradients.accentStateTint,
    border: `1px solid var(--wb-accent-soft-strong, ${colors.accentSoftStrong})`,
    borderRadius: radius.xxl,
    boxShadow: `0 0 0 1px var(--wb-accent-soft, ${colors.accentSoft}) inset, ${shadows.glowSoft}`,
  },
  hero: {
    background: gradients.paywallHero,
    color: colors.white,
    borderRadius: radius.hero,
    boxShadow: shadows.paywallHero,
    border: 'none',
  },
  glass: {
    ...glassBase,
    background: `var(--wb-card, ${colors.card})`,
    border: 'none',
    borderRadius: radius.xxl,
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
