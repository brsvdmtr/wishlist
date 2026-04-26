/**
 * Border-radius tokens — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * v2.1 shifts to rounder, softer corners across the board (+2–8px per tier).
 * The new scale reserves the traditional `xl=14` spot for input radius and
 * moves primary card/button radius up to 18.
 */
export const radius = {
  none: 0,
  xs: 4,    // fine bars (progress track, hairlines)
  sm: 7,    // badges, micro chips (was 6 in v2)
  md: 11,   // status pills (was 10 in v2)
  lg: 14,   // tabs, inner inline controls (was 12 in v2)
  input: 16, // form inputs, thumbnails (NEW tier in v2.1)
  xl: 18,   // PRIMARY — buttons, sheet-inner cards (was 14 in v2)
  xxl: 22,  // cards on home / list (was 16 in v2)
  hero: 26, // hero cards (was 20 in v2, repurposed from xxxl)
  sheet: 28, // bottom-sheet top corners (was 20 in v2)
  xxxl: 26, // @deprecated v2.1 renamed to `hero`; kept for back-compat
  fab: 20,  // FAB — v2.1 uses rounded-square, not circle
  full: 9999, // long pills
  circle: '50%' as const, // avatars, priority indicators, toggle knobs
} as const;

/**
 * Semantic radius aliases — use these in component code.
 */
export const radiusSemantic = {
  card: radius.xxl,         // 22 (v2.1)
  cardNested: radius.xl,    // 18 (smaller card-in-card)
  button: radius.xl,        // 18 (v2.1)
  fab: radius.fab,          // 20 (v2.1 — rounded-square)
  input: radius.input,      // 16 (v2.1)
  thumbnail: radius.lg,     // 14
  badge: radius.sm,         // 7 (v2.1)
  statusBadge: radius.md,   // 11 (v2.1)
  sheetTop: radius.sheet,   // 28 (v2.1)
  hero: radius.hero,        // 26 (v2.1)
  pill: radius.full,
  avatar: radius.circle,
  progressBar: radius.xs,   // 4
} as const;

export type RadiusToken = keyof typeof radius;
