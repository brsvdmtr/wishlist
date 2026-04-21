import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, gradients, shadows } from '@wishlist/ui-tokens';

/**
 * @status v2.1 refresh — glass-surface banners with backdrop-filter.
 * Accent-tone banners consume CSS vars so accent switching propagates.
 *
 * Per-tone:
 *   - `info` / `success` / `warning` / `danger` → **canonical**
 *   - `promo` → `provisional` (gradient-CTA banner, rare)
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-21--v21-refresh-approved-as-new-visual-direction-glass--mesh--theme-system`.
 */
export type BannerTone = 'info' | 'success' | 'warning' | 'danger' | 'promo';

export interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children: ReactNode;
  /** Leading icon / emoji. */
  icon?: ReactNode;
  /** Trailing action (button / link). */
  action?: ReactNode;
  /** Optional dismiss handler — renders an × button. */
  onClose?: () => void;
  /** Center-align content. Used for simple single-line messages. */
  center?: boolean;
  /** Subtle tone-colored border. Default `true` in v2.1 (glass surfaces need visible edge). */
  bordered?: boolean;
  style?: CSSProperties;
}

const toneStyles: Record<BannerTone, { bg: string; fg: string; border?: string; boxShadow?: string }> = {
  info: {
    bg: `var(--wb-accent-soft, ${colors.accentSoft})`,
    fg: `var(--wb-text, ${colors.text})`,
    border: `1px solid var(--wb-accent-soft-strong, ${colors.accentSoftStrong})`,
  },
  success: {
    bg: colors.successSoft,
    fg: `var(--wb-text, ${colors.text})`,
    border: '1px solid rgba(74,222,128,0.28)',
  },
  warning: {
    bg: colors.warningSoft,
    fg: `var(--wb-text, ${colors.text})`,
    border: '1px solid rgba(251,191,36,0.30)',
  },
  danger: {
    bg: colors.dangerSoft,
    fg: `var(--wb-text, ${colors.text})`,
    border: '1px solid rgba(251,113,133,0.30)',
  },
  promo: {
    bg: gradients.accentDiagonal,
    fg: colors.white,
    boxShadow: shadows.glowMedium,
  },
};

export function Banner({
  tone = 'info',
  title,
  children,
  icon,
  action,
  onClose,
  center = false,
  bordered = true,
  style,
}: BannerProps) {
  const t = toneStyles[tone];
  return (
    <div
      role="region"
      style={{
        background: t.bg,
        color: t.fg,
        border: bordered && tone !== 'promo' ? t.border : undefined,
        borderRadius: 16,
        padding: '13px 15px',
        fontSize: fontSize.base,
        lineHeight: 1.5,
        display: 'flex',
        gap: 11,
        alignItems: center ? 'center' : 'flex-start',
        textAlign: center ? 'center' : 'left',
        boxShadow: t.boxShadow,
        WebkitBackdropFilter: tone !== 'promo' ? ('blur(14px)' as never) : undefined,
        backdropFilter: tone !== 'promo' ? ('blur(14px)' as never) : undefined,
        ...style,
      }}
    >
      {icon && <div style={{ flexShrink: 0, fontSize: 17, lineHeight: 1, marginTop: center ? 0 : 1 }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontWeight: fontWeight.strong, marginBottom: 2, fontSize: fontSize.md }}>{title}</div>
        )}
        <div>{children}</div>
      </div>
      {action && <div style={{ flexShrink: 0, alignSelf: 'center' }}>{action}</div>}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 4,
            opacity: 0.6,
            fontSize: 16,
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
