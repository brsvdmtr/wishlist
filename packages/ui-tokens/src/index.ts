/**
 * @wishlist/ui-tokens — canonical design tokens for WishBoard.
 *
 * Source of truth for ALL visual values. Values aligned with approved
 * v2 North Star mockups (2026-04-19). See
 * `docs/design-system/NORTH_STAR.md` + `docs/design-system/mockups/approved/`.
 *
 * If a raw value isn't here, add it here (with semantic naming) before
 * using it in feature code.
 */

export { colors, avatarGradients, type ColorToken, type AvatarGradientToken } from './colors';
export {
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  textStyles,
  type FontSizeToken,
  type FontWeightToken,
  type TextStyleToken,
} from './typography';
export { spacing, spacingSemantic, type SpacingToken } from './spacing';
export { radius, radiusSemantic, type RadiusToken } from './radius';
export { shadows, type ShadowToken } from './shadows';
export {
  duration,
  easing,
  transition,
  pressedScale,
  keyframes,
  animation,
  type DurationToken,
  type EasingToken,
} from './motion';
export { zIndex, type ZIndexToken } from './zIndex';
export {
  touchTarget,
  iconSize,
  avatarSize,
  thumbnailSize,
  buttonHeight,
  inputHeight,
  type IconSizeToken,
  type AvatarSizeToken,
  type ButtonHeightToken,
} from './sizing';
export { gradients, type GradientToken } from './gradients';
export { safeArea, type SafeAreaToken } from './safeArea';
export { breakpoints, type Breakpoint } from './breakpoints';
