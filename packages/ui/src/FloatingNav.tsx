import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, shadows, transition } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Liquid-glass floating bottom nav with
 * glow underline indicator. Replaces the edge-docked solid nav from v2.
 *
 * Source: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (`.wb-nav` + `.wb-nav-item`).
 *
 * Items expect a short (1–2 word) RU label and an emoji `icon` (never an
 * SVG in the mini-app — per project iconography rule).
 */

export interface FloatingNavItem<ID extends string = string> {
  id: ID;
  label: ReactNode;
  icon: ReactNode;
}

export interface FloatingNavProps<ID extends string = string> {
  items: ReadonlyArray<FloatingNavItem<ID>>;
  active: ID;
  onSelect: (id: ID) => void;
  /** Additional positioning style (bottom offset, etc.). */
  style?: CSSProperties;
}

export function FloatingNav<ID extends string = string>({
  items,
  active,
  onSelect,
  style,
}: FloatingNavProps<ID>) {
  return (
    <nav
      style={{
        position: 'absolute',
        left: 10,
        right: 10,
        bottom: 14,
        display: 'flex',
        justifyContent: 'space-around',
        padding: '8px 6px',
        background: `var(--wb-nav-bg, ${colors.navBg})`,
        WebkitBackdropFilter: 'blur(28px) saturate(180%)' as never,
        backdropFilter: 'blur(28px) saturate(180%)' as never,
        border: `1px solid var(--wb-border, ${colors.border})`,
        borderRadius: 26,
        boxShadow: shadows.navFloating,
        zIndex: 10,
        ...style,
      }}
    >
      {items.map((it) => {
        const isActive = active === it.id;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onSelect(it.id)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '6px 4px',
              background: 'transparent',
              border: 'none',
              color: isActive
                ? `var(--wb-accent-strong, ${colors.accentStrong})`
                : `var(--wb-text-muted, ${colors.textMuted})`,
              fontSize: fontSize.micro,
              fontWeight: fontWeight.semiMedium,
              cursor: 'pointer',
              position: 'relative',
              transition: transition.colors,
              letterSpacing: 0,
            }}
          >
            <span style={{ fontSize: 20, lineHeight: 1 }}>{it.icon}</span>
            <span>{it.label}</span>
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  bottom: -3,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 14,
                  height: 3,
                  background: `var(--wb-accent, ${colors.accent})`,
                  borderRadius: radius.full,
                  boxShadow: `0 0 8px var(--wb-accent-shadow, ${colors.accentGlow})`,
                }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
