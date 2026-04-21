/**
 * Motion tokens — durations, easings, and canonical transition/animation strings.
 * Keyframes MUST be registered globally (see apps/web/app/globals.css).
 *
 * Respect `prefers-reduced-motion` in consuming components: disable non-essential
 * motion when reduced-motion is set.
 */
export const duration = {
  instant: '0.12s',   // micro-interactions, list item fade
  fast: '0.15s',      // PRIMARY — button feedback, hover
  normal: '0.2s',     // state change, tab switch
  slow: '0.3s',       // entrance: modal/sheet open, toast
  slower: '0.4s',     // progress fill
  slowest: '1s',      // long progress (linear)
} as const;

export const easing = {
  /** Default for nearly all transitions. */
  standard: 'ease',
  /** Material-motion — v2.1 default for UI state changes. */
  emphasized: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** Swift decelerate — v2.1 sheet open/close. */
  decelerate: 'cubic-bezier(0.25, 0.8, 0.35, 1)',
  /** Linear — for progress bars that shouldn't accelerate. */
  linear: 'linear',
  /** Spring-like — for success pops (approved onboarding success screen). */
  springOut: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

/**
 * Canonical transition presets — prefer these over custom CSS strings.
 * `transition.all` covers 90%+ of interactive state changes.
 *
 * v2.1 defaults to `emphasized` easing for UI state changes (tab switch,
 * card press, tile select) for a more modern feel.
 */
export const transition = {
  all: `all ${duration.fast} ${easing.standard}`,
  allEmph: `all ${duration.normal} ${easing.emphasized}`,
  allNormal: `all ${duration.normal} ${easing.standard}`,
  opacity: `opacity ${duration.fast} ${easing.standard}`,
  colors: `background ${duration.fast} ${easing.standard}, color ${duration.fast} ${easing.standard}, border-color ${duration.fast} ${easing.standard}`,
  transform: `transform ${duration.normal} ${easing.standard}`,
  boxShadow: `box-shadow ${duration.normal} ${easing.standard}`,
  /** Fast transform — used for pressed-state scale. */
  transformFast: `transform ${duration.fast} ${easing.standard}`,
  /** Sheet slide — v2.1 sheets use a slightly longer decelerate easing. */
  sheet: `transform 0.32s ${easing.decelerate}`,
} as const;

/**
 * Pressed-state transform scale factor. Approved mockups use 0.98 for
 * buttons, 0.995 for interactive cards. Signals tactile feedback.
 */
export const pressedScale = {
  button: 0.98,
  card: 0.995,
  tile: 0.97,
} as const;

/**
 * Keyframe names — must match `@keyframes` blocks in globals.css.
 * Keep in sync with the canonical keyframe registry.
 */
export const keyframes = {
  fadeIn: 'fadeIn',
  slideUp: 'slideUp',
  toastIn: 'toastIn',
  pulse: 'pulse',
  skeletonShimmer: 'skeletonShimmer',
  spin: 'onb-spin',
  /** Success check pop — used on onboarding success screen. */
  successPop: 'successPop',
  /** Gentle float — used on onboarding gift emoji hero. */
  float: 'float',
  /** Glow pulse — used behind floating hero. */
  glowPulse: 'glowPulse',
  /** Sparkle twinkle — small decorative elements on success. */
  sparkle: 'sparkle',
} as const;

/**
 * Canonical animation presets — use these exactly, don't improvise.
 */
export const animation = {
  fadeIn: `${keyframes.fadeIn} ${duration.slow} ${easing.standard}`,
  slideUp: `${keyframes.slideUp} ${duration.slow} ${easing.standard}`,
  toastIn: `${keyframes.toastIn} ${duration.slow} ${easing.standard}`,
  pulse: `${keyframes.pulse} 1.5s ease-in-out infinite`,
  /** Dot-indicator pulse (small accent-dot on active surfaces). 2s slow. */
  dotPulse: `${keyframes.pulse} 2s ease-in-out infinite`,
  shimmer: `${keyframes.skeletonShimmer} 1.5s ease-in-out infinite`,
  spin: `${keyframes.spin} 0.8s linear infinite`,

  /** Success check pop — 0.6s spring-out. */
  successPop: `${keyframes.successPop} 0.6s ${easing.springOut}`,
  /** Floating hero emoji — 4s gentle loop. */
  float: `${keyframes.float} 4s ease-in-out infinite`,
  /** Glow-pulse behind floating hero — 3s loop. */
  glowPulse: `${keyframes.glowPulse} 3s ease-in-out infinite`,
  /** Sparkle decoration — 1.5s loop. */
  sparkle: `${keyframes.sparkle} 1.5s ease-in-out infinite`,
} as const;

export type DurationToken = keyof typeof duration;
export type EasingToken = keyof typeof easing;
