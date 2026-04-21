import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, shadows } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Layered-gradient hero card for
 * wishlist-detail, paywall, profile. Composed of:
 *  1. White ambient highlight (top-left radial)
 *  2. Deep accent burst (bottom-right radial)
 *  3. Diagonal accent base (linear 135deg)
 *
 * Source: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (`.wb-hero`).
 *
 * Use for premium hero bands. Override padding via `style`. `tone="santa"`
 * switches to the seasonal green/red gradient (Santa surfaces only).
 */

export type HeroCardTone = 'accent' | 'santa';

export interface HeroCardProps {
  tone?: HeroCardTone;
  /** Rendered children — title, stats row, etc. */
  children: ReactNode;
  style?: CSSProperties;
}

const bg: Record<HeroCardTone, string> = {
  accent: `radial-gradient(circle at 20% 10%, rgba(255,255,255,0.25), transparent 45%), radial-gradient(circle at 100% 100%, var(--wb-accent-deep, ${colors.accentDeep}), transparent 55%), linear-gradient(135deg, var(--wb-accent, ${colors.accent}) 0%, var(--wb-accent-strong, ${colors.accentStrong}) 100%)`,
  santa: `radial-gradient(ellipse at top right, rgba(255,255,255,0.12), transparent 55%), linear-gradient(135deg, ${colors.santaGreenDark} 0%, ${colors.santaGreen} 60%, ${colors.santaRed} 130%)`,
};

const shadow: Record<HeroCardTone, string> = {
  accent: shadows.wishlistHero,
  santa: shadows.santaHero,
};

export function HeroCard({ tone = 'accent', children, style }: HeroCardProps) {
  return (
    <div
      style={{
        padding: 22,
        borderRadius: radius.hero,
        background: bg[tone],
        boxShadow: shadow[tone],
        color: colors.white,
        position: 'relative',
        overflow: 'hidden',
        // `isolation: isolate` creates a new stacking context so the
        // child glow's `filter: blur()` is properly clipped by the
        // parent's border-radius. Without it, Safari/WebKit sometimes
        // paints the unclipped rectangular bounds of the blurred child,
        // showing "corner ghosts" outside the rounded clipping path.
        isolation: 'isolate',
        ...style,
      }}
    >
      {/* Decorative top-right ambient glow */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '-30%',
          right: '-10%',
          width: 260,
          height: 260,
          background: 'radial-gradient(circle, rgba(255,255,255,0.22), transparent 70%)',
          pointerEvents: 'none',
          filter: 'blur(8px)',
          // Anchor the filter layer to the parent's stacking context.
          willChange: 'transform',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}
