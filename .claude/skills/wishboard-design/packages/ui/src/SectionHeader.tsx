import React, { type ReactNode } from 'react';
import { colors, fontSize, fontWeight, fontFamily, spacingSemantic } from '@wishlist/ui-tokens';

/**
 * @status canonical — approved 2026-04-19 via DESIGN_DECISIONS.md
 * entry `section-header-canonical`. Shape codified identically across
 * every approved v2 mockup (`mockups/approved/v2-*.html`).
 *
 * Primary (left-aligned) pattern: section-break header with optional
 * leading emoji + trailing action. Seen in every screen with grouped
 * content.
 *
 * `center` variant: centered dialog/sheet title (17/700/text) — same
 * typography role, different layout context. Used for sheet-content
 * titles above a subtitle+actions block.
 */
export interface SectionHeaderProps {
  children: ReactNode;
  /** Optional trailing action (link, icon button). Ignored when `center` is true. */
  action?: ReactNode;
  /** Optional leading emoji / icon. */
  icon?: ReactNode;
  /** Bottom margin. Default 16. */
  marginBottom?: number;
  /** Top margin — often used after a card group. Default 0. */
  marginTop?: number;
  /**
   * Center the title (sheet / dialog content title). When true:
   * - layout is plain block, not flex
   * - `action` slot is ignored (centered dialogs don't use inline actions)
   * - `icon` renders inline before text with 8px right-margin
   */
  center?: boolean;
}

export function SectionHeader({
  children,
  action,
  icon,
  marginBottom = 16,
  marginTop = 0,
  center = false,
}: SectionHeaderProps) {
  // Centered variant — simpler block rendering for dialog/sheet content titles.
  if (center) {
    return (
      <div
        style={{
          fontSize: fontSize.xxl,
          fontWeight: fontWeight.bold,
          color: colors.text,
          fontFamily: fontFamily.sans,
          letterSpacing: '-0.01em',
          textAlign: 'center',
          marginBottom,
          marginTop,
          lineHeight: 1.2,
        }}
      >
        {icon && <span style={{ marginRight: 8 }}>{icon}</span>}
        {children}
      </div>
    );
  }

  // Default — left-aligned section-break header with optional action slot.
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom,
        marginTop,
        gap: spacingSemantic.inlineIconGap,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: spacingSemantic.inlineIconGap,
          fontSize: fontSize.xxl,
          fontWeight: fontWeight.bold,
          color: colors.text,
          fontFamily: fontFamily.sans,
          letterSpacing: '-0.01em',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {icon && <span style={{ flexShrink: 0 }}>{icon}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}
