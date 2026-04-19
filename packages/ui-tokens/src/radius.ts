/**
 * Border-radius tokens — harvested from 14 distinct radius values in MiniApp.tsx.
 * Most frequent: 14 (cards/buttons), 12 (inputs/thumbnails), 6 (badges).
 */
export const radius = {
  none: 0,
  xs: 4,    // fine bars (progress)
  sm: 6,    // badges, micro chips
  md: 10,   // status pills
  lg: 12,   // inputs, thumbnails, secondary cards
  xl: 14,   // PRIMARY — cards, buttons, sheets
  xxl: 16,  // profile/cover surfaces
  xxxl: 20, // bottom-sheet top corners
  full: 9999, // long pills
  circle: '50%' as const, // avatars, priority indicators, toggle knobs
} as const;

/**
 * Semantic radius aliases — use these in component code.
 */
export const radiusSemantic = {
  card: radius.xl,          // 14
  button: radius.xl,        // 14
  input: radius.lg,         // 12
  badge: radius.sm,         // 6
  statusBadge: radius.md,   // 10
  sheetTop: radius.xxxl,    // 20
  pill: radius.full,
  avatar: radius.circle,
  progressBar: radius.xs,   // 4
} as const;

export type RadiusToken = keyof typeof radius;
