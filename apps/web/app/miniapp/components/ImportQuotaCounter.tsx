import React from 'react';
import { t, type Locale } from '@wishlist/shared';

/**
 * Monthly URL-import quota counter — the slim strip under the Drafts URL
 * field. Tone escalates with the remaining free allowance:
 *   • ≥2 left  — accent-soft (calm)
 *   • 1 left   — warning-soft (last one)
 *   • 0 left, paid credits remain — neutral (shows the paid balance)
 *   • 0 left, no paid credits — danger-soft + tappable (opens the upsell)
 * PRO shows a quiet "unlimited" line.
 *
 * Composed from v2.1 tokens — see DESIGN_DECISIONS.md 2026-05-20. This is a
 * feature element, not a design-system primitive. Extracted from MiniApp.tsx
 * so the state→display logic is unit-testable in isolation.
 */
export function ImportQuotaCounter({ isPro, freeLeft, freeLimit, paidLeft, locale, onUpsell }: {
  isPro: boolean;
  freeLeft: number;
  freeLimit: number;
  paidLeft: number;
  locale: Locale;
  onUpsell: () => void;
}) {
  const base: React.CSSProperties = {
    marginTop: 10, display: 'flex', alignItems: 'center', gap: 8,
    padding: '9px 12px', borderRadius: 14, fontSize: 12.5,
    fontWeight: 550, lineHeight: 1.3,
  };

  if (isPro) {
    return (
      <div style={{ ...base, background: 'var(--wb-surface)', color: 'var(--wb-text-muted)' }}>
        <span>💜</span><span>{t('drafts_import_unlimited', locale)}</span>
      </div>
    );
  }

  if (freeLeft > 0) {
    const last = freeLeft === 1;
    return (
      <div style={{
        ...base,
        background: last ? 'var(--wb-warning-soft)' : 'var(--wb-accent-soft)',
        color: 'var(--wb-text-secondary)',
      }}>
        <span>{last ? '⚠️' : '↻'}</span>
        <span>{t('drafts_import_left', locale, { n: String(freeLeft), limit: String(freeLimit) })}</span>
      </div>
    );
  }

  if (paidLeft > 0) {
    return (
      <div style={{ ...base, background: 'var(--wb-surface)', color: 'var(--wb-text-secondary)' }}>
        <span>📦</span><span>{t('drafts_import_paid', locale, { n: String(paidLeft) })}</span>
      </div>
    );
  }

  // Free quota AND paid credits both exhausted — tappable, opens the upsell.
  return (
    <div
      onClick={onUpsell}
      role="button"
      tabIndex={0}
      style={{
        ...base, background: 'var(--wb-danger-soft)', color: 'var(--wb-text)',
        fontWeight: 650, justifyContent: 'space-between', cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🔒</span><span>{t('drafts_import_empty', locale)}</span>
      </span>
      <span style={{ color: 'var(--wb-accent-strong)', fontWeight: 700, flexShrink: 0 }}>›</span>
    </div>
  );
}
