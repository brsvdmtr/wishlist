/**
 * Component sizing tokens.
 * Minimum touch target is 44px per Apple HIG; buttons/icon buttons respect this.
 */

/** Minimum touch target — Apple HIG / Material. */
export const touchTarget = {
  min: 44,
} as const;

/** Icon sizes used inline in buttons, chips, list trailing, etc. */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export const avatarSize = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 52,
  xl: 72,
} as const;

/** Square thumbnails in list rows. */
export const thumbnailSize = {
  sm: 40,
  md: 52,
  lg: 72,
} as const;

export const buttonHeight = {
  sm: 36,
  md: 44,  // meets touch-target minimum
  lg: 50,  // hero CTA
} as const;

/** Inputs: content-only height (without border). */
export const inputHeight = {
  md: 48,  // padding 14 + fontSize 16 + lineHeight 22 gives effective 50, minus 2px border
} as const;

export type IconSizeToken = keyof typeof iconSize;
export type AvatarSizeToken = keyof typeof avatarSize;
export type ButtonHeightToken = keyof typeof buttonHeight;
