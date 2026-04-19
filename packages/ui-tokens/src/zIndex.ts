/**
 * z-index tokens — finite layered stack. Do not invent intermediate values.
 */
export const zIndex = {
  base: 0,
  raised: 10,
  /** Sticky CTA bar at screen bottom */
  sticky: 50,
  /** Modal/sheet backdrop */
  backdrop: 100,
  /** Modal/sheet content */
  sheet: 101,
  /** Dropdowns, popovers, context menus */
  dropdown: 150,
  /** Toast notifications — highest ordinary layer */
  toast: 200,
  /** Reserved for critical overlays (rare) */
  critical: 500,
} as const;

export type ZIndexToken = keyof typeof zIndex;
