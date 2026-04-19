import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, gradients, shadows } from '@wishlist/ui-tokens';

/**
 * @status provisional — 4 neutral tones (info/success/warning/danger) are
 * codified identically across every approved v2 mockup and can promote
 * to canonical soon. `promo` tone uses `gradients.accentDiagonal` — pending
 * first paywall migration to validate the CTA-composition before promoting.
 * See `docs/design-system/COMPONENT_REGISTRY.md`.
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
  style?: CSSProperties;
}

const toneStyles: Record<BannerTone, { bg: string; fg: string; boxShadow?: string }> = {
  info:    { bg: colors.accentSoft,  fg: colors.accent },
  success: { bg: colors.successSoft, fg: colors.success },
  warning: { bg: colors.warningSoft, fg: colors.warning },
  danger:  { bg: colors.dangerSoft,  fg: colors.danger },
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
  style,
}: BannerProps) {
  const t = toneStyles[tone];
  return (
    <div
      role="region"
      style={{
        background: t.bg,
        color: t.fg,
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
