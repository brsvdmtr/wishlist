import React, { type ReactNode, type CSSProperties } from 'react';
import { colors } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Sticky CTA region with fade-to-bg backdrop.
 * Absorbs a 15+-place inline repetition from the legacy MiniApp.tsx
 * (`.wb-cta-bar`).
 *
 * Source: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (`.wb-cta-bar`).
 *
 * Renders an absolutely-positioned bottom strip. `position:absolute` requires
 * the nearest ancestor with a stacking context (the `.wb-phone` root via
 * `ThemeProvider` creates one). Pointer-events pass through the gradient
 * fade except on actual children.
 */

export interface StickyCTAFadeProps {
  children: ReactNode;
  /** Override for bottom offset (e.g., when nav isn't shown). Default `0`. */
  bottom?: number | string;
  /** Override for horizontal padding. Default `16`. */
  paddingX?: number | string;
  style?: CSSProperties;
}

export function StickyCTAFade({
  children,
  bottom = 0,
  paddingX = 16,
  style,
}: StickyCTAFadeProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        padding: `16px ${typeof paddingX === 'number' ? `${paddingX}px` : paddingX} calc(16px + env(safe-area-inset-bottom))`,
        background: `linear-gradient(180deg, transparent, var(--wb-bg, ${colors.bg}) 40%)`,
        pointerEvents: 'none',
        zIndex: 5,
        ...style,
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>{children}</div>
    </div>
  );
}
