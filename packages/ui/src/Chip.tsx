import React, { type ReactNode, type HTMLAttributes, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, gradients, shadows } from '@wishlist/ui-tokens';

/**
 * @status provisional — unified chip component replacing ~10 ad-hoc
 * chip styles across approved mockups. Tones: neutral, accent, success,
 * warning, danger, surface, prio-1/2/3, new, pro.
 *
 * Source-of-truth: state-chip language in every approved v2 mockup.
 * See `docs/design-system/COMPONENTS.md#chip`.
 */
export type ChipTone =
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'surface'
  | 'prio-1'
  | 'prio-2'
  | 'prio-3'
  | /** New-item badge — accent fill + soft glow. */ 'new'
  | /** PRO badge — brand gradient fill. */ 'pro';

export type ChipSize = 'sm' | 'md' | 'lg';

export interface ChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'title'> {
  tone?: ChipTone;
  size?: ChipSize;
  /** Optional leading icon / emoji. */
  icon?: ReactNode;
  children: ReactNode;
}

const toneStyles: Record<ChipTone, CSSProperties> = {
  accent:   { background: colors.accentSoft,  color: colors.accent },
  success:  { background: colors.successSoft, color: colors.success },
  warning:  { background: colors.warningSoft, color: colors.warning },
  danger:   { background: colors.dangerSoft,  color: colors.danger },
  surface:  { background: colors.surface,     color: colors.textSecondary },
  'prio-1': { background: colors.priorityLowSoft,    color: colors.priorityLow },
  'prio-2': { background: colors.priorityMediumSoft, color: colors.priorityMedium },
  'prio-3': { background: colors.priorityHighSoft,   color: colors.priorityHigh },
  new:      { background: colors.accent, color: colors.white, boxShadow: shadows.notificationAccent },
  pro:      { background: gradients.accentDiagonal, color: colors.white, boxShadow: shadows.chipPro },
};

const sizeStyles: Record<ChipSize, CSSProperties> = {
  sm: { padding: '2px 7px', fontSize: 10, borderRadius: radius.sm },
  md: { padding: '3px 8px', fontSize: fontSize.xs, borderRadius: radius.sm },
  lg: { padding: '5px 10px', fontSize: fontSize.sm, borderRadius: radius.full },
};

export function Chip({ tone = 'accent', size = 'md', icon, children, style, ...rest }: ChipProps) {
  // 'pro' tone is always pill-shaped regardless of size (visual signature).
  const effectiveSize: CSSProperties =
    tone === 'pro'
      ? { ...sizeStyles[size], borderRadius: radius.full, padding: '5px 10px', letterSpacing: '0.3px' }
      : sizeStyles[size];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontWeight: fontWeight.bold,
        whiteSpace: 'nowrap',
        lineHeight: 1,
        ...effectiveSize,
        ...toneStyles[tone],
        ...style,
      }}
      {...rest}
    >
      {icon && <span style={{ lineHeight: 1 }}>{icon}</span>}
      {children}
    </span>
  );
}
