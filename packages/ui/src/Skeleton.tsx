'use client';

import React, { type CSSProperties } from 'react';
import { radius, spacing, animation } from '@wishlist/ui-tokens';

/**
 * Loading placeholder primitive. Renders a stack of shimmering blocks
 * that roughly match the layout of the target screen so dynamic-import
 * transitions don't flash empty.
 *
 * Variants are intentionally coarse — they're shape hints, not pixel
 * matches. Use the closest match; the goal is to occupy roughly the
 * same vertical space the real screen will, so layout doesn't jump
 * when the chunk resolves.
 *
 * Approval: `DESIGN_DECISIONS.md#2026-05-25--skeleton-primitive-extracted-to-packages-ui`.
 * Registry: promoted from `legacy` → `provisional` 2026-05-25.
 *
 * @status provisional (2026-05-25)
 */
export type SkeletonVariant = 'list' | 'form' | 'calendar' | 'settings';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Accessible label announced by screen readers. Caller is expected
   *  to localize. Defaults to "Loading" (English) for the cases where
   *  the skeleton renders before any locale context is available
   *  (initial dynamic chunk fetch). */
  label?: string;
  style?: CSSProperties;
}

export function Skeleton({ variant = 'list', label = 'Loading', style }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy={true}
      aria-label={label}
      style={{
        minHeight: 320,
        padding: `${spacing[3]}px 0`,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing[3],
        ...style,
      }}
    >
      <SkeletonBlock width="40%" height={28} />
      {variant === 'list' && (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}
      {variant === 'form' && (
        <>
          <SkeletonBlock width="100%" height={56} />
          <SkeletonBlock width="100%" height={56} />
          <SkeletonBlock width="100%" height={120} />
          <SkeletonBlock width="50%" height={44} />
        </>
      )}
      {variant === 'calendar' && (
        <>
          <SkeletonBlock width="100%" height={88} />
          <SkeletonBlock width="100%" height={220} />
          <SkeletonBlock width="60%" height={20} />
          <SkeletonRow />
          <SkeletonRow />
        </>
      )}
      {variant === 'settings' && (
        <>
          <SkeletonBlock width="100%" height={64} />
          <SkeletonBlock width="100%" height={64} />
          <SkeletonBlock width="100%" height={64} />
          <SkeletonBlock width="100%" height={64} />
        </>
      )}
    </div>
  );
}

function SkeletonBlock({ width, height }: { width: string | number; height: number }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius.lg,
        background: 'var(--wb-surface, rgba(255,255,255,0.035))',
        animation: animation.shimmer,
        flexShrink: 0,
      }}
    />
  );
}

function SkeletonRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3] }}>
      <SkeletonBlock width={48} height={48} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: spacing[1.5] }}>
        <SkeletonBlock width="60%" height={14} />
        <SkeletonBlock width="40%" height={12} />
      </div>
    </div>
  );
}
