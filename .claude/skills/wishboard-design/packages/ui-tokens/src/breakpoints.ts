/**
 * Viewport breakpoints — the surface is a Telegram Mini App WebView,
 * so narrow widths dominate. Breakpoints exist mainly for defensive wrapping.
 */
export const breakpoints = {
  sm: 375,   // iPhone SE / compact WebView
  md: 414,   // modern phones
  lg: 768,   // tablet
  xl: 1024,  // desktop WebView (rare)
} as const;

export type Breakpoint = keyof typeof breakpoints;
