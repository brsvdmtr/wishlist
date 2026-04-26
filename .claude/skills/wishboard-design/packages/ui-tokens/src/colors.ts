/**
 * Canonical color tokens — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (approved 2026-04-21, see DESIGN_DECISIONS.md). These are the **Dark + Violet**
 * defaults; runtime theme/accent switching is performed via CSS variables
 * scoped to `.wb-phone[data-theme][data-accent]` — see `theme.ts`.
 *
 * v2.1 shifts from solid dark surfaces to **translucent glass over a mesh
 * gradient**. Most `card`/`surface` tokens are now rgba (not hex) and require
 * `backdrop-filter: blur(...)` on the consumer for the glass look.
 *
 * Do NOT add new raw hex values without first checking this file.
 */
export const colors = {
  // ───── Surfaces — dark-first, glass on top of mesh ─────
  /** Phone root background (behind mesh gradient). */
  bg: '#0F0F12',
  /** Elevated base — sheets, non-glass surfaces. */
  bgElev: '#15151A',
  /** Translucent surface for header/tab chrome. */
  surface: 'rgba(255,255,255,0.035)',
  surfaceHover: 'rgba(255,255,255,0.06)',
  /** Translucent card — primary container (needs `backdrop-filter: blur(14-16px)`). */
  card: 'rgba(255,255,255,0.045)',
  /** Stronger card for pressed / highlighted state. */
  cardStrong: 'rgba(255,255,255,0.07)',
  /** @deprecated v2.1 uses `cardStrong`. Kept for legacy MiniApp.tsx consumers. */
  cardElevated: 'rgba(255,255,255,0.07)',
  /** Floating nav background. */
  navBg: 'rgba(15,15,18,0.72)',

  // ───── Brand — violet default (runtime-switchable) ─────
  accent: '#8B7BFF',
  accentStrong: '#B4A6FF',
  accentLight: '#C8BDFF',
  accentDeep: '#5B48E5',
  /** @deprecated v2.1 collapses to `accentDeep`. Kept for legacy callers. */
  accentDeeper: '#5B48E5',
  /** @deprecated v2.1 collapses to `accentLight`. */
  accentTint: '#C8BDFF',
  /** RGB channel values for rgba-composition (e.g. mesh gradients, dynamic glows). */
  accentR: 139,
  accentG: 123,
  accentB: 255,
  /** Soft accent tint — backgrounds, banners, soft buttons. */
  accentSoft: 'rgba(139,123,255,0.14)',
  /** Stronger soft accent — borders on soft-accent surfaces. */
  accentSoftStrong: 'rgba(139,123,255,0.30)',
  /** Accent glow — shadow channel for CTA buttons and pressed states. */
  accentGlow: 'rgba(139,123,255,0.45)',
  /** Softer accent glow — ambient shadow on list cards. */
  accentGlowSoft: 'rgba(139,123,255,0.25)',

  // ───── Semantic states (v2.1 palette, slightly brighter than v2) ─────
  success: '#4ADE80',
  successSoft: 'rgba(74,222,128,0.14)',
  successStrong: '#10b981',
  successLight: '#6ee7b7',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.14)',
  warningStrong: '#f59e0b',
  danger: '#FB7185',
  dangerSoft: 'rgba(251,113,133,0.14)',

  // ───── Typography — v2.1 shifts to pure white + cooler greys ─────
  text: '#FFFFFF',
  textSecondary: '#C7CAD1',
  textMuted: '#8F94A3',
  textOnAccent: '#FFFFFF',

  // ───── Borders / hairlines ─────
  border: 'rgba(255,255,255,0.06)',
  borderLight: 'rgba(255,255,255,0.10)',
  /** Stronger border for pressed/active states and glass card edges. */
  borderStrong: 'rgba(255,255,255,0.12)',
  /** Hairline for divider rows inside cards. */
  hairline: 'rgba(255,255,255,0.04)',

  // ───── Priority scale (unchanged from v2; kept for back-compat) ─────
  priorityLow: '#6B7FD4',
  priorityLowSoft: 'rgba(107,127,212,0.15)',
  priorityLowGlow: 'rgba(107,127,212,0.25)',
  priorityLowEnd: '#818cf8',
  priorityMedium: '#FBBF24',
  priorityMediumSoft: 'rgba(251,191,36,0.18)',
  priorityMediumGlow: 'rgba(251,191,36,0.30)',
  priorityMediumEnd: '#f59e0b',
  priorityHigh: '#FB7185',
  priorityHighSoft: 'rgba(251,113,133,0.18)',
  priorityHighGlow: 'rgba(251,113,133,0.35)',
  priorityHighEnd: '#F06AB4',

  // ───── Overlays ─────
  backdrop: 'rgba(0,0,0,0.6)',
  backdropSoft: 'rgba(0,0,0,0.35)',

  // ───── Secret Santa — seasonal sub-product palette (do NOT use outside Santa surfaces) ─────
  santaGreenDark: '#0f5f3c',
  santaGreen: '#1a8552',
  santaRed: '#d92020',

  // ───── Literals ─────
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
} as const;

/**
 * Named avatar gradients — identity-preserving color assignments for
 * user avatars. v2.1 slightly shifts base colors to match new palette.
 */
export const avatarGradients = {
  /** Default (primary user) — brand accent. */
  accent: 'linear-gradient(135deg, #8B7BFF, #B4A6FF)',
  /** Amber — 2nd participant. */
  amber: 'linear-gradient(135deg, #FBBF24, #F59E0B)',
  /** Green — 3rd participant. */
  green: 'linear-gradient(135deg, #4ADE80, #10B981)',
  /** Pink — 4th participant. */
  pink: 'linear-gradient(135deg, #F892C9, #F06AB4)',
  /** Blue — 5th participant. */
  blue: 'linear-gradient(135deg, #86ABF5, #5B8DEF)',
} as const;

export type ColorToken = keyof typeof colors;
export type AvatarGradientToken = keyof typeof avatarGradients;
