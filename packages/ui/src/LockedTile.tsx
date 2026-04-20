import React, { type ReactNode, type HTMLAttributes, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, fontFamily } from '@wishlist/ui-tokens';

/**
 * @status provisional — inline "limit reached / feature gated" upsell tile.
 * Soft paywall nudge that sits inline in list flow, NOT a modal.
 *
 * Approval source: `v2-home-all-tabs.html` Wishlists-tab limit tile
 * («Лимит 3/3 на FREE · Unlock») + Reservations-tab history tile
 * («История броней · PRO»). Visual spec:
 *   - accent-tinted gradient background
 *   - dashed accent border (signals "locked but unlockable")
 *   - 40×40 icon slot (accent-soft rounded square)
 *   - title + optional sub
 *   - right-side CTA (accent-soft pill, accent text)
 *
 * Use for soft inline upsells. For hard paywall (modal + feature gate
 * enforcement) use ProUpsellSheet.
 */

export interface LockedTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'onClick'> {
  /** Left-side icon — emoji string or ReactNode (e.g. "🔒", "📜"). */
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** CTA label (e.g. "Unlock", "Разблокировать"). */
  ctaLabel: ReactNode;
  /** Called when user taps anywhere on the tile (typically opens paywall). */
  onClick?: () => void;
}

export function LockedTile({
  icon,
  title,
  subtitle,
  ctaLabel,
  onClick,
  style,
  ...rest
}: LockedTileProps) {
  const tileStyle: CSSProperties = {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: 16,
    borderRadius: radius.xl,
    background: `linear-gradient(135deg, rgba(124,106,255,0.06), rgba(124,106,255,0.02))`,
    border: `1px dashed rgba(124,106,255,0.25)`,
    cursor: onClick ? 'pointer' : undefined,
    WebkitTapHighlightColor: 'transparent',
    fontFamily: fontFamily.sans,
    ...style,
  };

  return (
    <div role={onClick ? 'button' : undefined} onClick={onClick} style={tileStyle} {...rest}>
      <div
        aria-hidden="true"
        style={{
          width: 40, height: 40,
          borderRadius: radius.lg,
          background: colors.accentSoft,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          flexShrink: 0,
        }}
      >{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: fontSize.base,
          fontWeight: fontWeight.semibold,
          color: colors.text,
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>{title}</div>
        {subtitle && (
          <div style={{
            fontSize: fontSize.sm,
            color: colors.textMuted,
            marginTop: 2,
            lineHeight: 1.4,
          }}>{subtitle}</div>
        )}
      </div>
      <div style={{
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.accent,
        padding: '6px 10px',
        borderRadius: radius.sm,
        background: colors.accentSoft,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>{ctaLabel}</div>
    </div>
  );
}
