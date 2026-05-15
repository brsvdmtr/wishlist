import React from 'react';

/**
 * Decorative Santa hat overlay positioned over an avatar circle. Pure SVG,
 * no state, no events — purely cosmetic. Used during the Santa season on
 * profile avatars + Santa participant avatars.
 *
 * Extracted from MiniApp.tsx (Phase 5b — extraction pilot).
 */
export function SantaHatOverlay({ size }: { size: number }) {
  const w = Math.round(size * 0.68);
  const h = Math.round(size * 0.58);
  return (
    <svg
      viewBox="0 0 44 40"
      width={w}
      height={h}
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: -Math.round(h * 0.52),
        right: -Math.round(w * 0.16),
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 2,
        overflow: 'visible',
        filter: 'drop-shadow(0 1px 2.5px rgba(0,0,0,.28))',
      }}
    >
      {/* Red cone — tip offset left of center gives a natural lean */}
      <polygon points="18,1 2,34 42,34" fill="#C41E1E" />
      {/* Slightly lighter inner sheen for depth */}
      <polygon points="18,1 10,34 26,34" fill="#D42828" opacity="0.35" />
      {/* White fur brim band */}
      <rect x="0" y="30" width="44" height="10" rx="5" fill="#F5F5F5" />
      {/* Subtle fur texture dots */}
      <circle cx="8"  cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="17" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="26" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="35" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      {/* White pom-pom at tip */}
      <circle cx="18" cy="5"  r="6.5" fill="#F5F5F5" />
      <circle cx="18" cy="5"  r="4.5" fill="white" />
    </svg>
  );
}
