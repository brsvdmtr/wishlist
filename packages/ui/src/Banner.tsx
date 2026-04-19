import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, gradients, shadows } from '@wishlist/ui-tokens';

/**
 * @status per-tone:
 *   - `info` / `success` / `warning` / `danger` → **canonical** (2026-04-19)
 *   - `promo` → `provisional` (pending first paywall migration)
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-19--banner-wave-1-adoption--neutral-tones-promoted-to-canonical`.
 * Visual source of truth: `mockups/approved/v2-*.html`.
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
  /**
   * Subtle tone-colored border. Default `false` (flat tinted banner).
   * Use `true` for emphasis banners (e.g., approved mockup don't-gift
   * block, item-purchased confirmation). `promo` tone ignores this —
   * gradient fill doesn't pair with border.
   */
  bordered?: boolean;
  style?: CSSProperties;
}

const toneStyles: Record<BannerTone, { bg: string; fg: string; border?: string; boxShadow?: string }> = {
  info:    { bg: colors.accentSoft,  fg: colors.accent,  border: '1px solid rgba(124,106,255,0.20)' },
  success: { bg: colors.successSoft, fg: colors.success, border: '1px solid rgba(52,211,153,0.20)' },
  warning: { bg: colors.warningSoft, fg: colors.warning, border: '1px solid rgba(251,191,36,0.25)' },
  danger:  { bg: colors.dangerSoft,  fg: colors.danger,  border: '1px solid rgba(248,113,113,0.25)' },
  promo:   { bg: gradients.accentDiagonal, fg: colors.white, boxShadow: shadows.glowMedium },
};

export function Banner({
  tone = 'info',
  title,
  children,
  icon,
  action,
  onClose,
  center = false,
  bordered = false,
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
        borderRadius: radius.xl,
        padding: '12px 14px',
        fontSize: fontSize.base,
        lineHeight: 1.5,
        display: 'flex',
        gap: 12,
        alignItems: center ? 'center' : 'flex-start',
        textAlign: center ? 'center' : 'left',
        boxShadow: t.boxShadow,
        ...style,
      }}
    >
      {icon && <div style={{ flexShrink: 0, fontSize: 16, lineHeight: 1, marginTop: center ? 0 : 1 }}>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontWeight: fontWeight.bold, marginBottom: 2, fontSize: fontSize.md }}>{title}</div>
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
