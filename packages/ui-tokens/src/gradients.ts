/**
 * Gradient presets — canonical gradients observed in approved v2 mockups.
 *
 * Diagonal (135deg) = brand accent;
 * horizontal (90deg) = priority scale directional fills;
 * vertical (to top / 180deg) = fade-to-bg masks (sticky CTAs);
 * radial = hero-card depth and accent-glow halos.
 */
import { colors } from './colors';

export const gradients = {
  /* ─── Brand ──────────────────────────────────────────── */

  /** Primary brand CTA — hero buttons, promo banners. */
  accentDiagonal: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentStrong} 100%)`,
  /** Deeper brand blend — pressed/active states. */
  accentDeep: `linear-gradient(135deg, ${colors.accent}, ${colors.accentDeep})`,
  /** Softer accent blend — promotional tiles. */
  accentSoft: `linear-gradient(135deg, ${colors.accent}, ${colors.accentLight})`,

  /**
   * **Canonical paywall hero gradient.**
   * Multi-layer: two radials for depth + diagonal brand.
   * Source: approved mockup `v2-paywall.html` hero.
   * Use this exactly — never duplicate by hand.
   */
  paywallHero: `radial-gradient(ellipse at top right, rgba(255,255,255,0.18), transparent 55%), radial-gradient(ellipse at bottom left, rgba(91,75,214,0.4), transparent 55%), linear-gradient(135deg, #7C6AFF 0%, #9B8AFF 55%, #6B5CE7 100%)`,

  /* ─── Seasonal / sub-product ─────────────────────────── */

  /**
   * **Canonical Santa hero gradient.**
   * Green / red seasonal language for Secret Santa sub-product.
   * Source: approved mockup `v2-santa-campaign.html` hero.
   * MUST NOT mix with brand accent — Santa is visually distinct.
   */
  santaHero: `radial-gradient(ellipse at top right, rgba(255,255,255,0.12), transparent 55%), linear-gradient(135deg, #0f5f3c 0%, #1a8552 60%, #d92020 130%)`,

  /**
   * **Canonical showcase-profile cover gradient.**
   * Multi-stop (accent → amber) — premium but different from paywall.
   * Source: approved mockup `v2-showcase-profile.html` cover.
   */
  profileCover: `radial-gradient(ellipse at top right, rgba(255,255,255,0.15), transparent 50%), linear-gradient(135deg, #7C6AFF 0%, #A78BFA 50%, #FBBF24 130%)`,

  /* ─── Priority scale ─────────────────────────────────── */

  priorityLow: `linear-gradient(90deg, ${colors.priorityLow}, ${colors.priorityLowEnd})`,
  priorityMedium: `linear-gradient(90deg, ${colors.priorityMedium}, ${colors.priorityMediumEnd})`,
  priorityHigh: `linear-gradient(90deg, ${colors.priorityHigh}, ${colors.priorityHighEnd})`,

  /* ─── Fade-to-bg masks (sticky CTA regions) ──────────── */

  fadeToBg: `linear-gradient(to top, ${colors.bg} 65%, transparent)`,
  fadeFromBg: `linear-gradient(180deg, transparent, ${colors.bg} 25%)`,

  /* ─── State tints (card backgrounds with modifier) ───── */

  /**
   * Subtle accent-tinted card — signals "active" / "current" /
   * "secret-reserved" states. Pair with accent-color border.
   * Source: wishlist-detail owner current-card; secret-reservation card.
   */
  accentStateTint: `linear-gradient(135deg, ${colors.card}, rgba(124,106,255,0.04))`,

  /**
   * Subtle success-tinted card — signals "reserved by me (public)" state
   * in guest view. Pair with success-color border.
   * Source: wishlist-detail guest / state-matrix.
   */
  successStateTint: `linear-gradient(135deg, ${colors.card}, rgba(52,211,153,0.05))`,

  /**
   * Subtle warning-tinted card — signals "expiring soon" / "item updated"
   * states. Pair with warning-color border.
   * Source: reservations-pro / secret-reservation diff card.
   */
  warningStateTint: `linear-gradient(135deg, ${colors.card}, rgba(251,191,36,0.05))`,

  /**
   * Subtle danger-tinted card — signals "conflict" (public reserved by
   * other after secret). Pair with danger-color border.
   * Source: secret-reservation conflict card.
   */
  dangerStateTint: `linear-gradient(135deg, ${colors.card}, rgba(248,113,113,0.05))`,

  /* ─── Radial glow (decorative) ───────────────────────── */

  accentRadialGlow: `radial-gradient(circle, ${colors.accentGlow} 0%, transparent 70%)`,
  accentRadialGlowSoft: `radial-gradient(circle, rgba(124,106,255,0.3) 0%, transparent 70%)`,
} as const;

export type GradientToken = keyof typeof gradients;
