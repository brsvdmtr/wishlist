import React, { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import {
  colors,
  radius,
  fontSize,
  fontWeight,
  fontFamily,
  spacingSemantic,
  transition,
  shadows,
  gradients,
  buttonHeight,
  animation,
  pressedScale,
} from '@wishlist/ui-tokens';

/**
 * @status provisional — visual contract codified in approved v2 mockups
 * (see `docs/design-system/mockups/approved/v2-home-all-tabs.html`,
 * `v2-paywall.html`, `v2-onboarding.html`, `v2-wishlist-detail-*.html`).
 * Ready for canonical promotion after adoption validates the API.
 * See `docs/design-system/COMPONENT_REGISTRY.md`.
 */
export type ButtonVariant = 'primary' | 'primary-gradient' | 'secondary' | 'ghost' | 'danger' | 'surface';
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
    padding: `${spacingSemantic.buttonPaddingY}px ${spacingSemantic.buttonPaddingX}px`,
    fontSize: fontSize.lg,
    minHeight: buttonHeight.md,
  },
  lg: {
    padding: `${spacingSemantic.buttonPaddingY + 2}px ${spacingSemantic.buttonPaddingX}px`,
    fontSize: fontSize.xl,
    minHeight: buttonHeight.lg,
  },
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: { background: colors.accent, color: colors.white, boxShadow: shadows.elevated },
  /** Canonical brand gradient + composed glow + inset highlight. */
  'primary-gradient': {
    background: gradients.accentDiagonal,
    color: colors.white,
    boxShadow: shadows.glowCtaComposed,
  },
  secondary: { background: colors.accentSoft, color: colors.accent },
  ghost: { background: colors.transparent, color: colors.textMuted },
  danger: { background: colors.dangerSoft, color: colors.danger },
  /** Surface = card-colored with border; secondary-neutral actions. */
  surface: { background: colors.card, color: colors.text, border: `1px solid ${colors.border}` },
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
        fontWeight: fontWeight.bold,
        fontFamily: fontFamily.sans,
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        transition: transition.all,
        width: fullWidth ? '100%' : 'auto',
        opacity: isDisabled ? 0.55 : 1,
        letterSpacing: '-0.01em',
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

/**
 * Global CSS hook required for pressed-scale to work:
 *
 *   .wb-btn-pressed:active { transform: scale(var(--pressed-scale, 0.98)); }
 *
 * Already registered in apps/web/app/globals.css as part of the
 * approved v2 interaction system.
 */
