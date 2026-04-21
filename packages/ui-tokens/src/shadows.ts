/**
 * Shadow tokens — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * v2.1 shadows are layered and use the new violet accent (rgb 139,123,255).
 * New tier families: `nav-floating` (liquid-glass nav), `accent-layered`
 * (CTA button composition), `conic-ring` (profile hero glow), `mesh` family
 * (used inline as `background:` — see `gradients.ts`).
 */
export const shadows = {
  none: 'none',

  // ───── Subtle — minimum depth ─────
  subtle: '0 1px 3px rgba(0,0,0,0.20)',
  subtleStronger: '0 2px 8px rgba(0,0,0,0.30)',

  // ───── Elevated — buttons, primary surfaces ─────
  elevated: '0 2px 12px rgba(0,0,0,0.18)',

  // ───── Deep — sheets, modals, floating cards ─────
  deep: '0 8px 24px rgba(0,0,0,0.35)',
  deepStronger: '0 8px 32px rgba(0,0,0,0.40)',
  deepMax: '0 8px 40px rgba(0,0,0,0.40)',

  // ───── Overlay — dropdowns, context menus ─────
  overlay: '0 12px 40px rgba(0,0,0,0.60)',
  overlayCritical: '0 16px 48px rgba(0,0,0,0.60)',

  // ───── Brand glows — violet-accent colored shadows ─────
  glowSoft: '0 4px 20px rgba(139,123,255,0.15)',
  glowMedium: '0 4px 16px rgba(139,123,255,0.25)',
  glowStrong: '0 4px 16px rgba(139,123,255,0.35)',
  glowCta: '0 8px 24px rgba(139,123,255,0.40)',
  /** Layered glow for primary-gradient CTA — 3-stage composition. */
  glowCtaLayered: '0 12px 32px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.22)',
  /** @deprecated v2 name. Use `glowCtaLayered` in v2.1. */
  glowCtaComposed: '0 12px 32px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.22)',

  // ───── Ring accents ─────
  ringFocus: '0 0 0 4px rgba(139,123,255,0.14)',
  ringSelected: '0 0 0 2px rgba(139,123,255,0.15)',

  // ───── Notification / counter-badge glows ─────
  notificationDanger: '0 2px 6px rgba(251,113,133,0.45)',
  notificationAccent: '0 2px 6px rgba(139,123,255,0.30)',
  chipPro: '0 2px 8px rgba(139,123,255,0.25)',

  // ───── Hero-level composed shadows (premium surfaces) ─────
  /**
   * **Canonical paywall hero shadow (v2.1).** Layered accent + inset highlight.
   * Source: approved `v2.1-refresh-all-screens.html` hero.
   */
  paywallHero: '0 20px 50px -12px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24)',

  /**
   * Wishlist hero shadow — list-card top hero band.
   * Source: approved `v2.1-refresh-all-screens.html` wishlist detail.
   */
  wishlistHero: '0 20px 50px -12px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24)',

  /**
   * Santa seasonal hero shadow — distinct from accent heroes.
   * Source: approved `v2-santa-campaign.html` hero (v2 mockup still binding for Santa).
   */
  santaHero: '0 16px 40px rgba(0,0,0,0.40)',

  /** Showcase profile avatar over cover. */
  avatarOverCover: '0 8px 24px rgba(0,0,0,0.30)',

  /** Success check pop shadow (onboarding success). */
  successPopGlow: '0 12px 40px rgba(74,222,128,0.40), 0 0 0 4px rgba(74,222,128,0.20)',

  // ───── v2.1-specific new shadows ─────

  /**
   * **Floating bottom-nav shadow (v2.1).** Glass card with soft drop + inset highlight.
   * Source: `v2.1-refresh-all-screens.html` `.wb-nav`.
   */
  navFloating: '0 10px 30px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)',

  /**
   * **FAB shadow (v2.1).** Colored drop + subtle depression + inset highlight.
   * Source: `v2.1-refresh-all-screens.html` `.wb-fab`.
   */
  fabLayered: '0 14px 40px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.24), 0 1px 2px rgba(0,0,0,0.3)',

  /**
   * **Hero-sheet shadow (v2.1).** Bottom-sheet with upward drop.
   * Source: `v2.1-refresh-all-screens.html` `.wb-sheet`.
   */
  sheetUp: '0 -20px 60px rgba(0,0,0,0.5)',

  /**
   * **Wish-thumb inner glow (v2.1).** Inset highlight for thumbnails.
   * Source: `v2.1-refresh-all-screens.html` wish-row thumbs.
   */
  thumbInner: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 12px rgba(0,0,0,0.3)',

  /**
   * **Phone chrome shadow (v2.1).** Multi-layer for dev-scaffold phone frame.
   * Source: `v2.1-refresh-all-screens.html` `.wb-phone`.
   */
  phoneChrome: '0 60px 120px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06), 0 0 0 10px #111114, 0 0 0 11px #000',

  /**
   * **Avatar XL (profile hero) shadow (v2.1).** Accent drop + inset.
   * Source: `v2.1-refresh-all-screens.html` `.wb-avatar-xl`.
   */
  avatarXL: '0 12px 32px rgba(139,123,255,0.45), inset 0 2px 0 rgba(255,255,255,0.25)',

  /**
   * **Profile hero shadow (v2.1).** Ambient accent drop.
   * Source: `v2.1-refresh-all-screens.html` `.wb-profile-hero`.
   */
  profileHero: '0 20px 50px -20px rgba(139,123,255,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
} as const;

export type ShadowToken = keyof typeof shadows;
