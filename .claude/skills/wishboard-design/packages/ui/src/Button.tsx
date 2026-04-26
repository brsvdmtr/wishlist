import React, { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import {
  colors,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  letterSpacing,
  spacingSemantic,
  transition,
  shadows,
  gradients,
  buttonHeight,
  animation,
  pressedScale,
} from '@wishlist/ui-tokens';

/**
 * @status v2.1 refresh — consumes CSS vars set by ThemeProvider so accent
 * switches at runtime. All canonical variants inherit their previous status.
 *
 * Per-variant status (post-refresh):
 *   - `primary` / `secondary` / `ghost` → **canonical**
 *   - `primary-gradient` → **canonical** (layered accent gradient + composed glow)
 *   - `danger-solid` → **canonical** (destructive confirm CTAs)
 *   - `surface` → **canonical-v2.1** (glass-secondary action — matches v2.1
 *     Settings screen, Onboarding "Skip")
 *   - `danger` (soft/tinted) → `provisional` (candidate for deprecation)
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-21--v21-refresh-approved-as-new-visual-direction-glass--mesh--theme-system`.
 */
export type ButtonVariant = 'primary' | 'primary-gradient' | 'secondary' | 'ghost' | 'danger' | 'danger-solid' | 'surface';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width button. Default `true` — matches approved sticky-CTA pattern. */
  fullWidth?: boolean;
  /** Shows a spinner and disables interaction. */
  loading?: boolean;
  /** Pressed-state feedback via CSS scale on :active. Default `true`. */
  pressedEffect?: boolean;
  /**
   * Emit Telegram WebApp haptic feedback on click.
   * Requires `window.Telegram?.WebApp?.HapticFeedback` at runtime.
   * Primary / primary-gradient default to `'light'`; others default to none.
   */
  haptic?: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' | null;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
}

const sizeStyles: Record<ButtonSize, CSSProperties> = {
  sm: {
    padding: `${spacingSemantic.buttonPaddingYCompact - 2}px ${spacingSemantic.buttonPaddingXCompact}px`,
    fontSize: fontSize.base,
    minHeight: buttonHeight.sm,
  },
  md: {
    padding: `15px ${spacingSemantic.buttonPaddingX - 2}px`,
    fontSize: fontSize.lg,
    minHeight: 52,
  },
  lg: {
    padding: `17px ${spacingSemantic.buttonPaddingX}px`,
    fontSize: fontSize.xl,
    minHeight: 56,
  },
};

/** Use gradient (accent → accentDeep) composed via CSS vars so accent switching works. */
const gradientPrimary = 'linear-gradient(135deg, var(--wb-accent, #8B7BFF), var(--wb-accent-deep, #5B48E5))';
const gradientDiagonal = 'linear-gradient(135deg, var(--wb-accent, #8B7BFF), var(--wb-accent-strong, #B4A6FF))';

const ctaShadow = `0 12px 32px var(--wb-accent-shadow, ${colors.accentGlow}), inset 0 1px 0 rgba(255,255,255,0.22)`;

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: gradientPrimary,
    color: colors.white,
    boxShadow: ctaShadow,
  },
  /** Canonical brand gradient (diagonal) + composed glow + inset highlight. */
  'primary-gradient': {
    background: gradientPrimary,
    color: colors.white,
    boxShadow: ctaShadow,
  },
  secondary: {
    background: `var(--wb-accent-soft, ${colors.accentSoft})`,
    color: `var(--wb-accent-strong, ${colors.accentStrong})`,
    border: `1px solid var(--wb-accent-soft-strong, ${colors.accentSoftStrong})`,
  },
  ghost: {
    background: colors.transparent,
    color: `var(--wb-text-secondary, ${colors.textSecondary})`,
  },
  /** Soft danger — tinted background. For inline "maybe destructive" actions. */
  danger: { background: colors.dangerSoft, color: colors.danger },
  /** Solid danger — flat fill. Canonical for destructive-confirm CTAs. */
  'danger-solid': { background: colors.danger, color: colors.white, boxShadow: shadows.elevated },
  /** Surface = glass card with strong border; neutral secondary (Settings, Onboarding skip). */
  surface: {
    background: `var(--wb-card-strong, ${colors.cardStrong})`,
    color: `var(--wb-text, ${colors.text})`,
    border: `1px solid var(--wb-border-strong, ${colors.borderStrong})`,
    WebkitBackdropFilter: 'blur(14px)' as never,
    backdropFilter: 'blur(14px)' as never,
  },
};

function tryHaptic(kind: NonNullable<ButtonProps['haptic']>) {
  if (typeof window === 'undefined') return;
  try {
    const tg = (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: { impactOccurred?: (k: string) => void } } } })
      .Telegram?.WebApp?.HapticFeedback;
    tg?.impactOccurred?.(kind);
  } catch {
    /* noop — haptics are best-effort */
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    fullWidth = true,
    loading = false,
    disabled,
    pressedEffect = true,
    haptic,
    leftIcon,
    rightIcon,
    type = 'button',
    style,
    children,
    onClick,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  // Resolve default haptic based on variant if not explicitly set.
  const resolvedHaptic: NonNullable<ButtonProps['haptic']> | null =
    haptic === null ? null : haptic ?? (variant === 'primary' || variant === 'primary-gradient' ? 'light' : null);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    if (resolvedHaptic) tryHaptic(resolvedHaptic);
    onClick?.(e);
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      onClick={handleClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacingSemantic.inlineIconGap,
        borderRadius: radius.xl,
        border: 'none',
        fontWeight: fontWeight.strong,
        fontFamily: fontFamily.sans,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        transition: transition.allEmph,
        width: fullWidth ? '100%' : 'auto',
        opacity: isDisabled ? 0.55 : 1,
        letterSpacing: letterSpacing.tighter,
        ...sizeStyles[size],
        ...variantStyles[variant],
        ...(pressedEffect && !isDisabled ? { ['--pressed-scale' as unknown as string]: pressedScale.button } : {}),
        ...style,
      }}
      className={pressedEffect && !isDisabled ? 'wb-btn-pressed' : undefined}
      {...rest}
    >
      {loading ? <ButtonSpinner /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

function ButtonSpinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        animation: animation.spin,
      }}
    />
  );
}

// Keep `gradientDiagonal` exported type-wise for potential future overrides
export const _internalGradients = { gradientPrimary, gradientDiagonal };
