import React, { type CSSProperties, type ReactNode } from 'react';
import { colors, radius, fontSize, fontWeight } from '@wishlist/ui-tokens';

/**
 * @status provisional — compact number + label tile.
 *
 * Source: approved `v2-wishlist-detail-owner.html` stat-row (12 желаний /
 * 4 забронировано / 2 куплено). Also `v2-secret-reservation.html`
 * hero-meta row (5 активных / 2 требуют внимания).
 */
export type StatTileTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatTileProps {
  n: number | string;
  label: ReactNode;
  tone?: StatTileTone;
  /** Compact inline version — used in hero blocks rather than card tiles. */
  inline?: boolean;
  style?: CSSProperties;
}

const toneColor: Record<StatTileTone, string> = {
  neutral: colors.text,
  accent: colors.accent,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
};

const toneBorder: Record<StatTileTone, string> = {
  neutral: colors.border,
  accent: 'rgba(124,106,255,0.25)',
  success: 'rgba(52,211,153,0.25)',
  warning: 'rgba(251,191,36,0.25)',
  danger: 'rgba(248,113,113,0.25)',
};

const toneBg: Record<StatTileTone, string> = {
  neutral: colors.card,
  accent: `linear-gradient(135deg, ${colors.card}, rgba(124,106,255,0.04))`,
  success: `linear-gradient(135deg, ${colors.card}, rgba(52,211,153,0.04))`,
  warning: `linear-gradient(135deg, ${colors.card}, rgba(251,191,36,0.04))`,
  danger: `linear-gradient(135deg, ${colors.card}, rgba(248,113,113,0.04))`,
};

export function StatTile({ n, label, tone = 'neutral', inline = false, style }: StatTileProps) {
  if (inline) {
    return (
      <div style={{ color: 'inherit', ...style }}>
        <div style={{ fontSize: 22, fontWeight: fontWeight.extrabold, letterSpacing: '-0.02em', lineHeight: 1 }}>{n}</div>
        <div style={{ fontSize: fontSize.xs, opacity: 0.8, marginTop: 2 }}>{label}</div>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        background: toneBg[tone],
        border: `1px solid ${toneBorder[tone]}`,
        borderRadius: radius.lg,
        padding: '10px 12px',
        textAlign: 'center',
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: fontWeight.extrabold,
          letterSpacing: '-0.01em',
          color: toneColor[tone],
          lineHeight: 1.1,
        }}
      >
        {n}
      </div>
      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2, letterSpacing: 0.2 }}>{label}</div>
    </div>
  );
}
