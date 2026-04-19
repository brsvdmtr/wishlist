import type { Config } from 'tailwindcss';
import {
  colors,
  fontSize,
  fontFamily,
  spacing,
  radius,
  shadows,
  zIndex,
  duration,
} from '@wishlist/ui-tokens';

/**
 * Tailwind surface is kept intentionally small — the Mini App renders almost
 * entirely with inline `style={{}}` today. Tokens here exist so any NEW Tailwind
 * usage lines up with the same canonical values.
 *
 * Do not add arbitrary utilities. If a value is missing, add it to
 * `packages/ui-tokens` first.
 */
export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [fontFamily.sans, 'var(--font-sans)', 'ui-sans-serif', 'system-ui'],
        display: ['var(--font-display)', 'ui-serif', 'Georgia'],
      },
      colors: {
        // Mirror of @wishlist/ui-tokens — generated shape, do not hand-edit.
        bg: colors.bg,
        surface: colors.surface,
        'surface-hover': colors.surfaceHover,
        card: colors.card,
        accent: colors.accent,
        'accent-soft': colors.accentSoft,
        'accent-strong': colors.accentStrong,
        'accent-deep': colors.accentDeep,
        success: colors.success,
        'success-soft': colors.successSoft,
        warning: colors.warning,
        'warning-soft': colors.warningSoft,
        danger: colors.danger,
        'danger-soft': colors.dangerSoft,
        text: colors.text,
        'text-secondary': colors.textSecondary,
        'text-muted': colors.textMuted,
        border: colors.border,
        'border-light': colors.borderLight,
      },
      fontSize: {
        micro: `${fontSize.micro}px`,
        xs: `${fontSize.xs}px`,
        sm: `${fontSize.sm}px`,
        base: `${fontSize.base}px`,
        md: `${fontSize.md}px`,
        lg: `${fontSize.lg}px`,
        xl: `${fontSize.xl}px`,
        '2xl': `${fontSize.xxl}px`,
        '3xl': `${fontSize.display}px`,
        '4xl': `${fontSize.hero}px`,
      },
      spacing: {
        // Evidence-based scale. Tailwind default `px` aliases mostly aligned.
        '1.5': `${spacing[1.5]}px`,
        '3.5': `${spacing[3.5]}px`,
      },
      borderRadius: {
        xs: `${radius.xs}px`,
        sm: `${radius.sm}px`,
        md: `${radius.md}px`,
        lg: `${radius.lg}px`,
        xl: `${radius.xl}px`,
        '2xl': `${radius.xxl}px`,
        '3xl': `${radius.xxxl}px`,
      },
      boxShadow: {
        subtle: shadows.subtle,
        elevated: shadows.elevated,
        deep: shadows.deep,
        overlay: shadows.overlay,
        'glow-soft': shadows.glowSoft,
        'glow-medium': shadows.glowMedium,
        'glow-strong': shadows.glowStrong,
        // Backwards compat: previous name kept as alias
        soft: '0 20px 60px rgba(2, 6, 23, 0.08)',
      },
      zIndex: {
        sticky: String(zIndex.sticky),
        backdrop: String(zIndex.backdrop),
        sheet: String(zIndex.sheet),
        dropdown: String(zIndex.dropdown),
        toast: String(zIndex.toast),
      },
      transitionDuration: {
        fast: (duration.fast.replace('s', '000')),
        normal: (duration.normal.replace('s', '000')),
        slow: (duration.slow.replace('s', '000')),
      },
    },
  },
  plugins: [],
} satisfies Config;
