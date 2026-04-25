import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, fontSize, fontWeight, fontFamily } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Page-level `<h1>` title used at the top of
 * 15+ screens in the Mini App. Distinct from `<SectionHeader>` (which is for
 * mid-page section breaks at `fontSize.xxl`).
 *
 * Spec (from approved v2.1 mockup):
 *   - fontSize 26 / fontWeight 700
 *   - letter-spacing −0.035em
 *   - line-height 1.05
 *   - font: var(--wb-font)
 *   - color: var(--wb-text)
 *
 * Source: `mockups/approved/v2.1-refresh-all-screens.html` (`.wb-h1`).
 */
export interface PageTitleProps {
  children: ReactNode;
  /** Optional leading emoji / icon. Rendered before children with no inline styling. */
  icon?: ReactNode;
  /** Optional trailing slot — typically a sibling action button. */
  action?: ReactNode;
  /** Optional subtitle paragraph rendered under the title. */
  subtitle?: ReactNode;
  /** Bottom margin. Default 20. */
  marginBottom?: number;
  /** Top margin. Default 0. */
  marginTop?: number;
  /** Additional style for the wrapper. */
  style?: CSSProperties;
}

export function PageTitle({
  children, icon, action, subtitle,
  marginBottom = 20, marginTop = 0, style,
}: PageTitleProps) {
  const titleStyle: CSSProperties = {
    fontSize: 26,
    fontWeight: fontWeight.bold,
    fontFamily: fontFamily.sans,
    color: `var(--wb-text, ${colors.text})`,
    letterSpacing: '-0.035em',
    lineHeight: 1.05,
    margin: 0,
  };

  // No action / subtitle — bare h1 in a top-margin wrapper.
  if (!action && !subtitle) {
    return (
      <h1 style={{ ...titleStyle, marginTop, marginBottom, ...style }}>
        {icon && <>{icon}{' '}</>}
        {children}
      </h1>
    );
  }

  // Action + (optional) subtitle: flex header with right-side action slot.
  return (
    <div style={{ marginTop, marginBottom, ...style }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={titleStyle}>
            {icon && <>{icon}{' '}</>}
            {children}
          </h1>
          {subtitle && (
            <p style={{
              fontSize: 13,
              color: `var(--wb-text-secondary, ${colors.textSecondary})`,
              margin: '4px 0 0',
              letterSpacing: '-0.005em',
              lineHeight: 1.4,
            }}>
              {subtitle}
            </p>
          )}
        </div>
        {action && <div style={{ flexShrink: 0, marginTop: 2 }}>{action}</div>}
      </div>
    </div>
  );
}
