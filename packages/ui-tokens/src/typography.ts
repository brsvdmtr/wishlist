/**
 * Typography tokens — harvested from inline `style={{ fontSize, fontWeight }}` usage.
 * Scale is compressed (10–32px) because the surface is a Telegram Mini App WebView.
 */
export const fontFamily = {
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif",
} as const;

/** Named scale in px. Use by role (see `textStyles`) rather than by size where possible. */
export const fontSize = {
  micro: 10,
  xs: 11,
  sm: 12,
  base: 13,
  md: 14,
  lg: 15,
  xl: 16,
  xxl: 17,
  display: 22,
  hero: 32,
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
} as const;

export const lineHeight = {
  tight: 1,
  snug: 1.2,
  normal: 1.3,
  relaxed: 1.4,
  loose: 1.5,
} as const;

/**
 * Semantic text roles — prefer these over raw `fontSize`/`fontWeight` combos.
 * These are the canonical compositions observed in the existing UI.
 */
export const textStyles = {
  splashTitle:   { fontSize: fontSize.display, fontWeight: fontWeight.extrabold, lineHeight: lineHeight.tight,   fontFamily: fontFamily.sans },
  sectionHeader: { fontSize: fontSize.xxl,     fontWeight: fontWeight.bold,      lineHeight: lineHeight.snug,    fontFamily: fontFamily.sans },
  cardTitle:     { fontSize: fontSize.lg,      fontWeight: fontWeight.semibold,  lineHeight: lineHeight.normal,  fontFamily: fontFamily.sans },
  body:          { fontSize: fontSize.lg,      fontWeight: fontWeight.medium,    lineHeight: lineHeight.relaxed, fontFamily: fontFamily.sans },
  bodyStrong:    { fontSize: fontSize.lg,      fontWeight: fontWeight.semibold,  lineHeight: lineHeight.relaxed, fontFamily: fontFamily.sans },
  secondary:     { fontSize: fontSize.md,      fontWeight: fontWeight.semibold,  lineHeight: lineHeight.normal,  fontFamily: fontFamily.sans },
  caption:       { fontSize: fontSize.base,    fontWeight: fontWeight.semibold,  lineHeight: lineHeight.snug,    fontFamily: fontFamily.sans },
  label:         { fontSize: fontSize.sm,      fontWeight: fontWeight.semibold,  lineHeight: lineHeight.snug,    fontFamily: fontFamily.sans },
  micro:         { fontSize: fontSize.micro,   fontWeight: fontWeight.bold,      lineHeight: lineHeight.tight,   fontFamily: fontFamily.sans },
} as const;

export type FontSizeToken = keyof typeof fontSize;
export type FontWeightToken = keyof typeof fontWeight;
export type TextStyleToken = keyof typeof textStyles;
