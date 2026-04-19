/**
 * Shadow tokens — tiered system harvested from approved v2 mockups
 * and inline `boxShadow` usage.
 *
 * Tiers:
 *   - subtle:   tiny depth (checkboxes, inline)
 *   - elevated: buttons, primary surfaces
 *   - deep:     sheets, modals
 *   - overlay:  dropdowns, menus
 *   - glow*:    brand-colored glows (accent CTAs)
 *   - notification: counter-badge colored drop shadows
 *   - hero:     composed shadows for premium heroes (paywall, onboarding)
 */
export const shadows = {
  none: 'none',

  // Subtle — minimum depth
  subtle: '0 1px 3px rgba(0,0,0,0.20)',
  subtleStronger: '0 2px 8px rgba(0,0,0,0.30)',

  // Elevated — buttons, primary surfaces
  elevated: '0 2px 12px rgba(0,0,0,0.18)',

  // Deep — sheets, modals, floating cards
  deep: '0 8px 24px rgba(0,0,0,0.35)',
  deepStronger: '0 8px 32px rgba(0,0,0,0.35)',
  deepMax: '0 8px 40px rgba(0,0,0,0.40)',

  // Overlay — dropdowns, context menus
  overlay: '0 12px 40px rgba(0,0,0,0.60)',
  overlayCritical: '0 16px 48px rgba(0,0,0,0.60)',

  // Brand glows — accent-colored shadows
  glowSoft: '0 4px 20px rgba(124,106,255,0.15)',
  glowMedium: '0 4px 16px rgba(124,106,255,0.25)',
  glowStrong: '0 4px 16px rgba(124,106,255,0.35)',
  glowCta: '0 8px 24px rgba(124,106,255,0.40)',
  /** Composed glow + subtle depression for primary-gradient buttons. */
  glowCtaComposed: '0 8px 24px rgba(124,106,255,0.40), 0 2px 8px rgba(124,106,255,0.25), inset 0 1px 0 rgba(255,255,255,0.20)',

  // Ring accents
  ringFocus: '0 0 0 3px rgba(124,106,255,0.12)',
  /** Selected-plan ring (paywall plan selector). */
  ringSelected: '0 0 0 2px rgba(124,106,255,0.15)',

  // Notification / counter-badge glows
  /** Red badge glow — counter on tab bars. */
  notificationDanger: '0 2px 6px rgba(248,113,113,0.45)',
  /** Accent badge glow — "new" chips on list rows. */
  notificationAccent: '0 2px 6px rgba(124,106,255,0.30)',
  /** PRO-chip badge glow. */
  chipPro: '0 2px 8px rgba(124,106,255,0.25)',

  // Hero-level composed shadows (premium surfaces)
  /**
   * **Canonical paywall hero shadow.** Triple-layer for depth.
   * Source: approved `v2-paywall.html` hero.
   */
  paywallHero: '0 20px 48px rgba(124,106,255,0.40), 0 8px 24px rgba(124,106,255,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',

  /**
   * Santa seasonal hero shadow — matches hero-gradient depth but
   * without accent-color (Santa is visually distinct).
   * Source: approved `v2-santa-campaign.html` hero.
   */
  santaHero: '0 16px 40px rgba(0,0,0,0.40)',

  /** Showcase profile avatar over cover. */
  avatarOverCover: '0 8px 24px rgba(0,0,0,0.30)',

  /** Success check pop shadow (onboarding success). */
  successPopGlow: '0 12px 40px rgba(52,211,153,0.40), 0 0 0 4px rgba(52,211,153,0.20)',
} as const;

export type ShadowToken = keyof typeof shadows;
