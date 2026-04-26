/**
 * Gradient presets — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * v2.1 gradients are layered and frequently composite 2–3 radial + linear
 * passes. Accent colors shifted to new violet defaults (#8B7BFF / #B4A6FF /
 * #5B48E5). The "mesh" gradient is the signature backdrop painted on every
 * phone root.
 *
 * Diagonal (135deg) = brand accent;
 * horizontal (90deg) = priority scale directional fills;
 * vertical (to top / 180deg) = fade-to-bg masks (sticky CTAs);
 * radial = hero-card depth + mesh + accent-glow halos.
 */
import { colors } from './colors';

export const gradients = {
  /* ─── Brand ──────────────────────────────────────────── */

  /** Primary brand CTA — hero buttons, primary-gradient variant. */
  accentDiagonal: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentStrong} 100%)`,
  /** Deeper brand blend — pressed/active button states, CTA variant. */
  accentDeep: `linear-gradient(135deg, ${colors.accent}, ${colors.accentDeep})`,
  /** Softer accent blend — ambient tiles, thumbnails. */
  accentSoft: `linear-gradient(135deg, ${colors.accentSoftStrong}, ${colors.accentSoft})`,

  /**
   * **Mesh gradient (v2.1 signature).** Painted as `::before` on the phone
   * root — three layered radials for a chroma-soft backdrop.
   * Source: approved `v2.1-refresh-all-screens.html` `.wb-phone::before`.
   */
  mesh: `radial-gradient(ellipse 80% 60% at 12% 0%, rgba(139,123,255,0.22), transparent 55%), radial-gradient(ellipse 60% 50% at 100% 20%, rgba(255,120,180,0.10), transparent 55%), radial-gradient(ellipse 100% 70% at 50% 110%, rgba(139,123,255,0.10), transparent 65%)`,

  /**
   * Softer mesh variant for Black theme.
   * Source: `v2.1-refresh-all-screens.html` `.wb-phone[data-theme="black"]`.
   */
  meshBlack: `radial-gradient(ellipse 80% 60% at 12% 0%, rgba(139,123,255,0.18), transparent 55%), radial-gradient(ellipse 60% 50% at 100% 20%, rgba(255,120,180,0.06), transparent 55%)`,

  /**
   * **Canonical paywall hero gradient (v2.1).**
   * Layered: white highlight + deep accent burst + diagonal brand base.
   * Source: `v2.1-refresh-all-screens.html` `.wb-hero` + paywall title.
   */
  paywallHero: `radial-gradient(circle at 20% 10%, rgba(255,255,255,0.25), transparent 45%), radial-gradient(circle at 100% 100%, ${colors.accentDeep}, transparent 55%), linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentStrong} 100%)`,

  /**
   * **Canonical wishlist hero gradient (v2.1).** Same composition as paywall
   * hero — signals premium depth.
   */
  wishlistHero: `radial-gradient(circle at 20% 10%, rgba(255,255,255,0.25), transparent 45%), radial-gradient(circle at 100% 100%, ${colors.accentDeep}, transparent 55%), linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentStrong} 100%)`,

  /**
   * **Canonical profile hero gradient (v2.1).** Layered ambient drops.
   * Source: `v2.1-refresh-all-screens.html` `.wb-profile-hero`.
   */
  profileHero: `radial-gradient(circle at 50% 120%, ${colors.accentDeep}, transparent 60%), radial-gradient(circle at 100% 0%, ${colors.accentStrong}, transparent 50%), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))`,

  /* ─── Seasonal / sub-product ─────────────────────────── */

  /**
   * **Canonical Santa hero gradient.**
   * Source: approved `v2-santa-campaign.html` hero (v2 mockup still binding).
   */
  santaHero: `radial-gradient(ellipse at top right, rgba(255,255,255,0.12), transparent 55%), linear-gradient(135deg, ${colors.santaGreenDark} 0%, ${colors.santaGreen} 60%, ${colors.santaRed} 130%)`,

  /**
   * **Canonical showcase-profile cover gradient (v2).**
   * Source: approved `v2-showcase-profile.html` cover.
   * v2.1 refresh pending — reuse until refresh lands.
   */
  profileCover: `radial-gradient(ellipse at top right, rgba(255,255,255,0.15), transparent 50%), linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentLight} 50%, ${colors.warning} 130%)`,

  /* ─── Priority scale ─────────────────────────────────── */

  priorityLow: `linear-gradient(90deg, ${colors.priorityLow}, ${colors.priorityLowEnd})`,
  priorityMedium: `linear-gradient(90deg, ${colors.priorityMedium}, ${colors.priorityMediumEnd})`,
  priorityHigh: `linear-gradient(90deg, ${colors.priorityHigh}, ${colors.priorityHighEnd})`,

  /* ─── Fade masks (sticky CTA regions) ──────────── */

  /** @deprecated v2.1 renamed to `fadeFromBg`. Kept for back-compat. */
  fadeToBg: `linear-gradient(to top, ${colors.bg} 65%, transparent)`,
  /** Used behind sticky CTA to blend into bg. */
  fadeFromBg: `linear-gradient(180deg, transparent, ${colors.bg} 40%)`,
  /** Tab-active fill (v2.1) — subtle top-highlight glass. */
  tabActive: 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05))',
  /** Segmented-control active fill. */
  segActive: 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04))',

  /* ─── State tints (v2.1 — for translucent card modifiers) ───── */

  /**
   * Accent-tinted card modifier — layers on top of translucent card surface.
   * Applied via `background: linear-gradient(...), var(--wb-card)`.
   */
  accentStateTint: `linear-gradient(135deg, ${colors.cardStrong}, ${colors.accentSoft})`,
  successStateTint: `linear-gradient(135deg, ${colors.card}, rgba(74,222,128,0.09))`,
  warningStateTint: `linear-gradient(135deg, ${colors.card}, rgba(251,191,36,0.09))`,
  dangerStateTint: `linear-gradient(135deg, ${colors.card}, rgba(251,113,133,0.09))`,

  /* ─── Radial glow (decorative) ───────────────────────── */

  accentRadialGlow: `radial-gradient(circle, ${colors.accentGlow} 0%, transparent 70%)`,
  accentRadialGlowSoft: `radial-gradient(circle, ${colors.accentGlowSoft} 0%, transparent 70%)`,

  /* ─── Accent swatches (for Settings theme+accent picker) ───── */

  swatchViolet: `linear-gradient(135deg, #8B7BFF, #5B48E5)`,
  swatchBlue: `linear-gradient(135deg, #5B8DEF, #2F61C8)`,
  swatchPink: `linear-gradient(135deg, #F06AB4, #C53F88)`,
  swatchGreen: `linear-gradient(135deg, #34C98A, #1E9765)`,

  /* ─── Events Calendar — event-type theme gradients (v2.1) ────── */

  /** Birthday hero — pink, with white radial highlight. */
  eventBdayHero: `radial-gradient(circle at 100% 0%, rgba(255,255,255,0.18), transparent 50%), linear-gradient(135deg, #F06AB4 0%, #C53F88 100%)`,
  /** Birthday tile — solid pink linear (small date tiles). */
  eventBdayTile: `linear-gradient(135deg, #F06AB4, #C53F88)`,
  /** Anniversary hero — amber. */
  eventAnniversaryHero: `radial-gradient(circle at 100% 0%, rgba(255,255,255,0.18), transparent 50%), linear-gradient(135deg, #FBBF24 0%, #D97706 100%)`,
  eventAnniversaryTile: `linear-gradient(135deg, #FBBF24, #D97706)`,
  /** Holiday hero — green. */
  eventHolidayHero: `radial-gradient(circle at 100% 0%, rgba(255,255,255,0.18), transparent 50%), linear-gradient(135deg, #34C98A 0%, #1E9765 100%)`,
  eventHolidayTile: `linear-gradient(135deg, #34C98A, #1E9765)`,
  /** Today / brand-accent (own / custom). */
  eventTodayHero: `radial-gradient(circle at 100% 0%, rgba(255,255,255,0.18), transparent 50%), linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentDeep} 100%)`,
  eventTodayTile: `linear-gradient(135deg, ${colors.accent}, ${colors.accentDeep})`,
  /** Year-Recap signature gradient. */
  recapHero: `radial-gradient(circle at 30% 100%, rgba(240,106,180,0.45), transparent 50%), radial-gradient(circle at 80% 0%, rgba(139,123,255,0.55), transparent 55%), linear-gradient(135deg, #2A1F4A, #4A2A5C)`,
} as const;

export type GradientToken = keyof typeof gradients;
