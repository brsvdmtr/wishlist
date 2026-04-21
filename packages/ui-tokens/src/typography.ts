/**
 * Typography tokens — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * v2.1 shifts weight preferences: most UI text uses the new `650` weight
 * (between semibold and bold) for a softer, more modern feel. Hero titles
 * use tighter letter-spacing (-0.025 to -0.035em).
 */
export const fontFamily = {
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', sans-serif",
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
  // v2.1 additions for richer hierarchy
  sectionLg: 19,   // sheet titles, calendar month
  displaySm: 22,   // stat-n, profile name, paywall-sub feature
  /** @deprecated v2.1 renamed to `displaySm`. Kept for back-compat. */
  display: 22,
  displayMd: 26,   // hero title, onboarding h1
  displayLg: 30,   // onboarding top h1
  hero: 32,        // paywall title
} as const;

/**
 * Font weights — v2.1 adds `550` and `650` half-stops between the standard
 * 500/600/700/800 values. Native font stack renders these smoothly on iOS
 * (-apple-system) and Android (Roboto).
 */
export const fontWeight = {
  regular: 400,
  medium: 500,
  /** v2.1 — nav items, meta labels. */
  semiMedium: 550,
  semibold: 600,
  /** v2.1 — card titles, wish-rows, nav active, buttons (most UI text). */
  strong: 650,
  bold: 700,
  extrabold: 800,
} as const;

export const lineHeight = {
  tight: 1,
  snug: 1.05,
  normal: 1.25,
  relaxed: 1.35,
  loose: 1.5,
} as const;

/**
 * Letter-spacing tokens — v2.1 tightens display typography.
 */
export const letterSpacing = {
  wide: '0.5px',
  wider: '0.7px',
  micro: '0.3px',
  normal: '0',
  tightSm: '-0.005em',
  tight: '-0.012em',
  tighter: '-0.015em',
  display: '-0.025em',
  hero: '-0.035em',
} as const;

/**
 * Semantic text roles — prefer these over raw `fontSize`/`fontWeight` combos.
 * v2.1 canonical compositions.
 */
export const textStyles = {
  heroTitle:     { fontSize: fontSize.hero,       fontWeight: fontWeight.bold,     lineHeight: lineHeight.snug,   letterSpacing: letterSpacing.hero,    fontFamily: fontFamily.sans },
  displayTitle:  { fontSize: fontSize.displayLg,  fontWeight: fontWeight.bold,     lineHeight: lineHeight.snug,   letterSpacing: letterSpacing.hero,    fontFamily: fontFamily.sans },
  splashTitle:   { fontSize: fontSize.displayMd,  fontWeight: fontWeight.bold,     lineHeight: lineHeight.snug,   letterSpacing: letterSpacing.hero,    fontFamily: fontFamily.sans },
  statNumber:    { fontSize: fontSize.displaySm,  fontWeight: fontWeight.bold,     lineHeight: lineHeight.tight,  letterSpacing: letterSpacing.display, fontFamily: fontFamily.sans },
  sectionHeader: { fontSize: fontSize.xs,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.wider,   fontFamily: fontFamily.sans, textTransform: 'uppercase' as const },
  sheetTitle:    { fontSize: fontSize.sectionLg,  fontWeight: fontWeight.strong,   lineHeight: lineHeight.normal, letterSpacing: letterSpacing.display, fontFamily: fontFamily.sans },
  cardTitle:     { fontSize: fontSize.xxl,        fontWeight: fontWeight.strong,   lineHeight: lineHeight.snug,   letterSpacing: letterSpacing.display, fontFamily: fontFamily.sans },
  listRowTitle:  { fontSize: fontSize.lg,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.tight,   fontFamily: fontFamily.sans },
  body:          { fontSize: fontSize.lg,         fontWeight: fontWeight.medium,   lineHeight: lineHeight.relaxed, letterSpacing: letterSpacing.tightSm, fontFamily: fontFamily.sans },
  bodyStrong:    { fontSize: fontSize.lg,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.relaxed, letterSpacing: letterSpacing.tightSm, fontFamily: fontFamily.sans },
  secondary:     { fontSize: fontSize.md,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.normal, letterSpacing: letterSpacing.tightSm, fontFamily: fontFamily.sans },
  caption:       { fontSize: fontSize.base,       fontWeight: fontWeight.semiMedium, lineHeight: lineHeight.relaxed, letterSpacing: letterSpacing.tightSm, fontFamily: fontFamily.sans },
  label:         { fontSize: fontSize.sm,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.snug,    letterSpacing: letterSpacing.micro,   fontFamily: fontFamily.sans },
  labelUpper:    { fontSize: fontSize.xs,         fontWeight: fontWeight.semibold, lineHeight: lineHeight.snug,    letterSpacing: letterSpacing.wider,   fontFamily: fontFamily.sans, textTransform: 'uppercase' as const },
  micro:         { fontSize: fontSize.micro,      fontWeight: fontWeight.bold,     lineHeight: lineHeight.tight,   letterSpacing: letterSpacing.micro,   fontFamily: fontFamily.sans, textTransform: 'uppercase' as const },
  button:        { fontSize: fontSize.lg,         fontWeight: fontWeight.strong,   lineHeight: lineHeight.tight,   letterSpacing: letterSpacing.tighter, fontFamily: fontFamily.sans },
  navItem:       { fontSize: fontSize.micro,      fontWeight: fontWeight.semiMedium, lineHeight: lineHeight.tight, letterSpacing: letterSpacing.normal,  fontFamily: fontFamily.sans },
} as const;

export type FontSizeToken = keyof typeof fontSize;
export type FontWeightToken = keyof typeof fontWeight;
export type TextStyleToken = keyof typeof textStyles;
export type LetterSpacingToken = keyof typeof letterSpacing;
