import React, { type CSSProperties } from 'react';
import { colors, avatarGradients, type AvatarGradientToken } from '@wishlist/ui-tokens';

/**
 * @status provisional — overlapping-avatar pattern for relational
 * surfaces (shared-wishlist participants, group-gift contributors).
 *
 * Source: approved `v2-home-all-tabs.html` (shared-wishlist shared-with),
 * `v2-group-gift.html` (participants), `v2-santa-campaign.html`
 * (participants grid).
 *
 * Each avatar is -6px into its previous sibling with a 2px border-blend
 * to the parent background.
 */
export interface AvatarEntry {
  /** Displayed in avatar (initial letter, emoji, etc.). */
  label: string;
  /** Named avatar gradient — matches `avatarGradients` in tokens. */
  gradient?: AvatarGradientToken;
  /** Override gradient / color explicitly (rare). */
  background?: string;
}

export type AvatarStackSize = 'sm' | 'md';

export interface AvatarStackProps {
  avatars: AvatarEntry[];
  /** Max visible before collapsing the tail into a "+N" slot. Default 3. */
  max?: number;
  /** Size variant. Default `sm` (22px circles). */
  size?: AvatarStackSize;
  /** Border color — should match parent background. Default `colors.card`. */
  borderColor?: string;
  style?: CSSProperties;
}

const sizeMap: Record<AvatarStackSize, { dim: number; font: number; overlap: number }> = {
  sm: { dim: 22, font: 10, overlap: 6 },
  md: { dim: 28, font: 12, overlap: 8 },
};

export function AvatarStack({
  avatars,
  max = 3,
  size = 'sm',
  borderColor = colors.card,
  style,
}: AvatarStackProps) {
  const { dim, font, overlap } = sizeMap[size];
  const visible = avatars.slice(0, max);
  const extra = avatars.length - visible.length;

  return (
    <div style={{ display: 'flex', alignItems: 'center', ...style }}>
      {visible.map((a, i) => (
        <div
          key={i}
          style={{
            width: dim,
            height: dim,
            borderRadius: '50%',
            background: a.background ?? avatarGradients[a.gradient ?? 'accent'],
            border: `2px solid ${borderColor}`,
            marginLeft: i === 0 ? 0 : -overlap,
            fontSize: font,
            fontWeight: 700,
            color: colors.white,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {a.label}
        </div>
      ))}
      {extra > 0 && (
        <div
          style={{
            width: dim,
            height: dim,
            borderRadius: '50%',
            background: colors.surface,
            color: colors.textMuted,
            border: `2px solid ${borderColor}`,
            marginLeft: -overlap,
            fontSize: font,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}
