import React from 'react';

type ScreenSkeletonVariant = 'list' | 'form' | 'calendar' | 'settings';

interface ScreenSkeletonProps {
  variant?: ScreenSkeletonVariant;
}

/**
 * Loading placeholder for `next/dynamic({ ssr: false })` screens.
 * Renders a skeleton that roughly matches the layout of the target
 * screen so the transition doesn't flash empty.
 *
 * F1 of the MiniApp.tsx decomposition (docs/REFACTOR_MINIAPP_TSX_PLAN.md).
 */
export function ScreenSkeleton({ variant = 'list' }: ScreenSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      style={{
        minHeight: 320,
        padding: '12px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
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
      className="animate-pulse"
      style={{
        width,
        height,
        borderRadius: 14,
        background: 'var(--wb-surface, rgba(255,255,255,0.035))',
        flexShrink: 0,
      }}
    />
  );
}

function SkeletonRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <SkeletonBlock width={48} height={48} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SkeletonBlock width="60%" height={14} />
        <SkeletonBlock width="40%" height={12} />
      </div>
    </div>
  );
}
