/**
 * Canonical color tokens — harvested from approved v2 North Star mockups
 * and the in-code `C = {...}` constant in MiniApp.tsx.
 *
 * Do NOT add new raw hex values without first checking this file.
 * All values here are **approved** (2026-04-19) as the canonical palette.
 */
export const colors = {
  // Surfaces (dark-first mini app)
  bg: '#1B1B1F',
  surface: '#26262C',
  surfaceHover: '#2E2E36',
  card: '#2F2F38',
  cardElevated: '#33333D',

  // Brand — accent is the single primary color
  accent: '#7C6AFF',
  accentSoft: 'rgba(124,106,255,0.12)',
  accentGlow: 'rgba(124,106,255,0.25)',
  accentStrong: '#9B8AFF',
  accentLight: '#A78BFA',
  accentDeep: '#5B4BD6',
  accentDeeper: '#6B5CE7',
  accentTint: '#C4A7FF',

  // Semantic states
  success: '#34D399',
  successSoft: 'rgba(52,211,153,0.12)',
  successStrong: '#10b981',
  successLight: '#6ee7b7',
  warning: '#FBBF24',
  warningSoft: 'rgba(251,191,36,0.12)',
  warningStrong: '#f59e0b',
  danger: '#F87171',
  dangerSoft: 'rgba(248,113,113,0.12)',

  // Typography
  text: '#F4F4F6',
  textSecondary: '#9CA3AF',
  textMuted: '#6B7280',
  textOnAccent: '#FFFFFF',

  // Lines / borders
  border: 'rgba(255,255,255,0.06)',
  borderLight: 'rgba(255,255,255,0.10)',

  // Priority scale (used across item cards / indicators)
  priorityLow: '#6B7FD4',
  priorityLowSoft: 'rgba(107,127,212,0.15)',
  priorityLowGlow: 'rgba(107,127,212,0.25)',
  priorityLowEnd: '#818cf8',
  priorityMedium: '#E8930A',
  priorityMediumSoft: 'rgba(232,147,10,0.15)',
  priorityMediumGlow: 'rgba(232,147,10,0.30)',
  priorityMediumEnd: '#fbbf24',
  priorityHigh: '#F04E6E',
  priorityHighSoft: 'rgba(240,78,110,0.15)',
  priorityHighGlow: 'rgba(240,78,110,0.35)',
  priorityHighEnd: '#ff6b9d',

  // Overlays
  backdrop: 'rgba(0,0,0,0.6)',
  backdropSoft: 'rgba(0,0,0,0.35)',

  // Secret Santa — seasonal sub-product palette (do NOT use outside Santa surfaces)
  santaGreenDark: '#0f5f3c',
  santaGreen: '#1a8552',
  santaRed: '#d92020',

  // Literals
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
} as const;

/**
 * Named avatar gradients — identity-preserving color assignments for
 * user avatars. Match the overlapping-avatar stacks in approved mockups.
 */
export const avatarGradients = {
  /** Default (primary user) — brand accent */
  accent: `linear-gradient(135deg, ${colors.accent}, ${colors.accentLight})`,
  /** Amber — 2nd participant color */
  amber: 'linear-gradient(135deg, #fbbf24, #f59e0b)',
  /** Green — 3rd participant color */
  green: 'linear-gradient(135deg, #34d399, #10b981)',
  /** Pink — 4th participant color (rare) */
  pink: 'linear-gradient(135deg, #f472b6, #ec4899)',
  /** Blue — 5th participant color (rare) */
  blue: 'linear-gradient(135deg, #60a5fa, #3b82f6)',
} as const;

export type ColorToken = keyof typeof colors;
export type AvatarGradientToken = keyof typeof avatarGradients;
