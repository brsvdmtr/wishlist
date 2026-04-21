/**
 * Theme + accent system — WishBoard Mini App.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
 *
 * v2.1 introduces a runtime theme/accent switcher as a **PRO-gated** product
 * surface. The contract is:
 *
 *   `.wb-phone[data-theme="dark|black"][data-accent="violet|blue|pink|green"]`
 *
 * Free users get `dark + violet` only. PRO users unlock all 2×4 = 8 combos.
 *
 * CSS var injection should be performed by the `ThemeProvider` primitive
 * (see `@wishlist/ui`). This module provides the raw value matrix.
 */

/** Available background themes. */
export const themes = ['dark', 'black'] as const;
export type Theme = typeof themes[number];

/** Available accent palettes. */
export const accents = ['violet', 'blue', 'pink', 'green'] as const;
export type Accent = typeof accents[number];

/** Which (theme, accent) combos are FREE (available without PRO). */
export const freeThemeAccent: ReadonlyArray<{ theme: Theme; accent: Accent }> = [
  { theme: 'dark', accent: 'violet' },
] as const;

/** Predicate — is this combo free? All others require PRO. */
export function isFreeCombo(theme: Theme, accent: Accent): boolean {
  return freeThemeAccent.some((c) => c.theme === theme && c.accent === accent);
}

/**
 * Theme variable definitions — background + surfaces.
 * Injected as CSS vars on the phone root based on `data-theme`.
 */
export const themeVars = {
  dark: {
    bg: '#0F0F12',
    bgElev: '#15151A',
    surface: 'rgba(255,255,255,0.035)',
    surfaceHover: 'rgba(255,255,255,0.06)',
    card: 'rgba(255,255,255,0.045)',
    cardStrong: 'rgba(255,255,255,0.07)',
    navBg: 'rgba(15,15,18,0.72)',
    border: 'rgba(255,255,255,0.06)',
    borderStrong: 'rgba(255,255,255,0.12)',
    hairline: 'rgba(255,255,255,0.04)',
  },
  black: {
    bg: '#000000',
    bgElev: '#070709',
    surface: 'rgba(255,255,255,0.04)',
    surfaceHover: 'rgba(255,255,255,0.07)',
    card: 'rgba(255,255,255,0.05)',
    cardStrong: 'rgba(255,255,255,0.08)',
    navBg: 'rgba(0,0,0,0.78)',
    border: 'rgba(255,255,255,0.07)',
    borderStrong: 'rgba(255,255,255,0.14)',
    hairline: 'rgba(255,255,255,0.05)',
  },
} as const satisfies Record<Theme, {
  bg: string;
  bgElev: string;
  surface: string;
  surfaceHover: string;
  card: string;
  cardStrong: string;
  navBg: string;
  border: string;
  borderStrong: string;
  hairline: string;
}>;

/**
 * Accent variable definitions — injected based on `data-accent`.
 * RGB triplet is exposed separately so consumers can compose custom
 * rgba values (mesh gradients, dynamic glows).
 */
export const accentVars = {
  violet: {
    accent: '#8B7BFF',
    accentStrong: '#B4A6FF',
    accentLight: '#C8BDFF',
    accentDeep: '#5B48E5',
    accentR: 139,
    accentG: 123,
    accentB: 255,
  },
  blue: {
    accent: '#5B8DEF',
    accentStrong: '#86ABF5',
    accentLight: '#B5CDF9',
    accentDeep: '#2F61C8',
    accentR: 91,
    accentG: 141,
    accentB: 239,
  },
  pink: {
    accent: '#F06AB4',
    accentStrong: '#F892C9',
    accentLight: '#FCBCDD',
    accentDeep: '#C53F88',
    accentR: 240,
    accentG: 106,
    accentB: 180,
  },
  green: {
    accent: '#34C98A',
    accentStrong: '#58D9A3',
    accentLight: '#88E6BC',
    accentDeep: '#1E9765',
    accentR: 52,
    accentG: 201,
    accentB: 138,
  },
} as const satisfies Record<Accent, {
  accent: string;
  accentStrong: string;
  accentLight: string;
  accentDeep: string;
  accentR: number;
  accentG: number;
  accentB: number;
}>;

/** Human-readable labels for theme swatches (Russian-first). */
export const themeLabels: Record<Theme, string> = {
  dark: 'Dark',
  black: 'Black',
};

/** Human-readable labels for accent swatches (Russian-first). */
export const accentLabels: Record<Accent, string> = {
  violet: 'Violet',
  blue: 'Blue',
  pink: 'Pink',
  green: 'Green',
};
