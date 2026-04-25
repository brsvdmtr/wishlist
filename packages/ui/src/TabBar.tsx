import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, transition } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Segmented control for tab switching inside
 * a screen (home-tabs: Wishlists/Wishes/Reservations; reservations-tab:
 * Active/History; etc).
 *
 * Renders as a horizontal flex strip of equal-flex tabs with an accent-tinted
 * active state and a subtle inset bg.
 *
 * Source: `apps/web/app/miniapp/MiniApp.tsx` ~lines 11634 (homeTab) and
 * 12315 (resTab) — identical shapes duplicated across screens.
 *
 * Generic over the tab id type so consumers get exhaustive type checking.
 */
export interface TabBarItem<ID extends string = string> {
  id: ID;
  label: ReactNode;
  /** Optional leading emoji / icon. */
  icon?: ReactNode;
  /** Optional trailing badge (count, dot). */
  badge?: ReactNode;
}

export interface TabBarProps<ID extends string = string> {
  items: ReadonlyArray<TabBarItem<ID>>;
  active: ID;
  onSelect: (id: ID) => void;
  /** Visual size — `sm` is default screen-tab spec; `lg` for above-fold sticky bars. */
  size?: 'sm' | 'lg';
  /** Wrapper style override. */
  style?: CSSProperties;
}

export function TabBar<ID extends string = string>({
  items,
  active,
  onSelect,
  size = 'sm',
  style,
}: TabBarProps<ID>) {
  const tabPadding = size === 'lg' ? '12px 16px' : '8px 14px';
  const tabFontSize = size === 'lg' ? fontSize.lg : fontSize.base;

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 4,
        padding: 4,
        borderRadius: radius.lg,
        background: `var(--wb-surface, ${colors.surface})`,
        border: `1px solid var(--wb-border, ${colors.border})`,
        ...style,
      }}
    >
      {items.map((it) => {
        const isActive = it.id === active;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(it.id)}
            type="button"
            style={{
              flex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: tabPadding,
              borderRadius: radius.md,
              border: 'none',
              background: isActive
                ? `var(--wb-accent-soft, ${colors.accentSoft})`
                : 'transparent',
              color: isActive
                ? `var(--wb-accent-strong, ${colors.accentStrong})`
                : `var(--wb-text-muted, ${colors.textMuted})`,
              fontSize: tabFontSize,
              fontWeight: isActive ? fontWeight.semibold : fontWeight.medium,
              cursor: 'pointer',
              transition: transition.colors,
              whiteSpace: 'nowrap',
            }}
          >
            {it.icon && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{it.icon}</span>}
            <span>{it.label}</span>
            {it.badge && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{it.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
