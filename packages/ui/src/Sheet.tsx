import React, { useEffect, type ReactNode, type CSSProperties } from 'react';
import {
  colors,
  radius,
  spacingSemantic,
  safeArea,
  zIndex,
  animation,
  shadows,
  fontSize,
  fontWeight,
  duration,
  easing,
} from '@wishlist/ui-tokens';

/**
 * @status provisional — exit animation and nested-sheet cases are not yet
 * spec'd. Bottom-sheet contract is stable in current prod.
 * See `docs/design-system/COMPONENT_REGISTRY.md`.
 */
export interface SheetProps {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Max height as CSS. Default `85vh` matches the existing bottom-sheet pattern. */
  maxHeight?: string;
  dismissOnBackdrop?: boolean;
  /** Show the drag handle. Default `true`. */
  handle?: boolean;
  /** Disable body scroll while open. Default `true`. */
  lockBodyScroll?: boolean;
  contentStyle?: CSSProperties;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  maxHeight = '85vh',
  dismissOnBackdrop = true,
  handle = true,
  lockBodyScroll = true,
  contentStyle,
}: SheetProps) {
  useEffect(() => {
    if (!open || !lockBodyScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, lockBodyScroll]);

  if (!open) return null;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={dismissOnBackdrop ? onClose : undefined}
        style={{
          position: 'fixed',
          inset: 0,
          background: colors.backdrop,
          zIndex: zIndex.backdrop,
          animation: `fadeIn ${duration.normal} ${easing.standard}`,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: colors.surface,
          borderTopLeftRadius: radius.xxxl,
          borderTopRightRadius: radius.xxxl,
          padding: spacingSemantic.sheetPadding,
          paddingBottom: safeArea.sheetContentBottom,
          zIndex: zIndex.sheet,
          maxHeight,
          overflowY: 'auto',
          animation: animation.slideUp,
          willChange: 'transform',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch' as never,
          boxShadow: shadows.deepMax,
          ...contentStyle,
        }}
      >
        {handle && (
          <div
            aria-hidden="true"
            style={{
              width: 40,
              height: 4,
              borderRadius: radius.full,
              background: colors.textMuted,
              margin: '0 auto 16px',
              opacity: 0.3,
            }}
          />
        )}
        {title && (
          <div
            style={{
              fontSize: fontSize.xxl,
              fontWeight: fontWeight.bold,
              marginBottom: spacingSemantic.sheetTitleGap,
              color: colors.text,
            }}
          >
            {title}
          </div>
        )}
        {children}
      </div>
    </>
  );
}
