import React from 'react';
import { t, type Locale } from '@wishlist/shared';

export type HintQuotaState = {
  isPro: boolean;
  freeLeft: number;
  freeLimit: number;
  paidLeft: number;
  locale: Locale;
};

/**
 * The quota line for the current "hint friends" allowance. The 4-branch
 * wording lives here so the item-detail hint card stays declarative.
 */
function hintQuotaLabel({ isPro, freeLeft, freeLimit, paidLeft, locale }: HintQuotaState): string {
  if (isPro) return t('hints_quota_unlimited', locale);
  if (freeLeft > 0) return t('hints_quota_left', locale, { n: String(freeLeft), limit: String(freeLimit) });
  if (paidLeft > 0) return t('hints_quota_paid', locale, { n: String(paidLeft) });
  return t('hints_quota_empty', locale);
}

/**
 * Monthly "hint friends" quota counter — the slim strip under the hint card on
 * the item-detail screen. Tone escalates with the remaining free allowance,
 * mirroring ImportQuotaCounter:
 *   • ≥2 left  — accent-soft (calm)
 *   • 1 left   — warning-soft (last one)
 *   • 0 left, paid credits remain — neutral (shows the paid balance)
 *   • 0 left, no paid credits — danger-soft + tappable (opens the upsell)
 * PRO shows a quiet "unlimited" line.
 *
 * Composed from v2.1 tokens. Feature element, not a design-system primitive —
 * the sibling of ImportQuotaCounter (see DESIGN_DECISIONS.md).
 */
export function HintQuotaCounter({ isPro, freeLeft, freeLimit, paidLeft, locale, onUpsell }: HintQuotaState & {
  onUpsell: () => void;
}) {
  const base: React.CSSProperties = {
    marginTop: 10, display: 'flex', alignItems: 'center', gap: 8,
    padding: '9px 12px', borderRadius: 14, fontSize: 12.5,
    fontWeight: 550, lineHeight: 1.3,
  };
  const label = hintQuotaLabel({ isPro, freeLeft, freeLimit, paidLeft, locale });

  if (isPro) {
    return (
      <div style={{ ...base, background: 'var(--wb-surface)', color: 'var(--wb-text-muted)' }}>
        <span>💜</span><span>{label}</span>
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
        <span>{last ? '⚠️' : '💡'}</span>
        <span>{label}</span>
      </div>
    );
  }

  if (paidLeft > 0) {
    return (
      <div style={{ ...base, background: 'var(--wb-surface)', color: 'var(--wb-text-secondary)' }}>
        <span>📦</span><span>{label}</span>
      </div>
    );
  }

  // Free quota AND paid credits both exhausted — tappable, opens the upsell.
  return (
    <div
      onClick={onUpsell}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onUpsell(); }
      }}
      role="button"
      tabIndex={0}
      style={{
        ...base, background: 'var(--wb-danger-soft)', color: 'var(--wb-text)',
        fontWeight: 650, justifyContent: 'space-between', cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🔒</span><span>{label}</span>
      </span>
      <span style={{ color: 'var(--wb-accent-strong)', fontWeight: 700, flexShrink: 0 }}>›</span>
    </div>
  );
}
