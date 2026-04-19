/**
 * Safe-area inset helpers for Telegram Mini App WebView.
 * Telegram WebView on iPhone X+ has a non-zero bottom inset; sticky footers
 * and full-viewport modals must respect it.
 */
export const safeArea = {
  bottom: 'env(safe-area-inset-bottom, 0px)',
  top: 'env(safe-area-inset-top, 0px)',
  left: 'env(safe-area-inset-left, 0px)',
  right: 'env(safe-area-inset-right, 0px)',

  /** Sticky CTA bottom padding — use on the sticky container. */
  stickyCtaBottom: 'max(16px, env(safe-area-inset-bottom, 16px))',

  /** Full-viewport modal / onboarding splash bottom padding. */
  sheetBottom: 'calc(40px + env(safe-area-inset-bottom, 0px))',

  /** Bottom-sheet padding when content + handle are inside. */
  sheetContentBottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
} as const;

export type SafeAreaToken = keyof typeof safeArea;
