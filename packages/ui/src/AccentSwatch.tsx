import React, { type CSSProperties } from 'react';
import { gradients, type Accent, type Theme } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Color-swatch tile for the Settings
 * theme/accent picker. Renders a gradient-filled square with an optional
 * padlock (PRO-gated) and an active ring. Used inside `AccentGrid` /
 * `ThemeGrid` patterns in the Settings screen.
 *
 * Source: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (`.wb-accent-swatch`, `.wb-theme-card`).
 */

export type SwatchKind = { kind: 'accent'; value: Accent } | { kind: 'theme'; value: Theme };

export interface AccentSwatchProps {
  swatch: SwatchKind;
  active: boolean;
  locked: boolean;
  label?: string;
  onClick: () => void;
  style?: CSSProperties;
}

const accentGradients: Record<Accent, string> = {
  violet: gradients.swatchViolet,
  blue: gradients.swatchBlue,
  pink: gradients.swatchPink,
  green: gradients.swatchGreen,
};

const themeBgs: Record<Theme, string> = {
  dark: '#0F0F12',
  black: '#000000',
};

export function AccentSwatch({ swatch, active, locked, label, onClick, style }: AccentSwatchProps) {
  const background =
    swatch.kind === 'accent' ? accentGradients[swatch.value] : themeBgs[swatch.value];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        position: 'relative',
        width: '100%', // required — without it `aspect-ratio` measures
        // from content width, which varies with label length (Violet: 6
        // letters → wider square than Blue: 4 letters).
        aspectRatio: '1 / 1',
        boxSizing: 'border-box',
        borderRadius: 16,
        background,
        border: active ? '2px solid #fff' : '2px solid transparent',
        boxShadow: active
          ? '0 0 0 3px rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.22), 0 8px 20px rgba(0,0,0,0.35)'
          : 'inset 0 1px 0 rgba(255,255,255,0.22), 0 4px 12px rgba(0,0,0,0.3)',
        opacity: locked ? 0.6 : 1,
        cursor: 'pointer',
        padding: 10,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {/* Ambient highlight overlay */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.25), transparent 55%)',
          pointerEvents: 'none',
        }}
      />
      {label && (
        <span
          style={{
            color: '#fff',
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: '0.2px',
            position: 'relative',
            textShadow: '0 1px 2px rgba(0,0,0,0.3)',
          }}
        >
          {label}
        </span>
      )}
      {locked && (
        <span
          aria-label="PRO-only"
          style={{
            position: 'absolute',
            top: 7,
            right: 8,
            fontSize: 12,
            zIndex: 1,
          }}
        >
          🔒
        </span>
      )}
    </button>
  );
}
