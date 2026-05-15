import React from 'react';
import { SantaHatOverlay } from './SantaHatOverlay';

/**
 * Deterministic hash of an alias string → hue (0–350 in 10° steps).
 * Same alias always produces the same hue so a participant's avatar stays
 * stable across re-renders. FNV-1a 32-bit hash.
 */
export function santaAliasHue(alias: string): number {
  let h = 2166136261;
  for (let i = 0; i < alias.length; i++) {
    h ^= alias.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 36) * 10;
}

/**
 * SantaAvatar — anonymous emoji avatar for Secret Santa. Background colour
 * derives from the alias string deterministically (`santaAliasHue`), so the
 * avatar is stable per participant across re-renders. Never shows real
 * profile photos. Pass `hat={true}` during season for the festive overlay.
 *
 * Extracted from MiniApp.tsx (Phase 5b — extraction pilot).
 */
export function SantaAvatar({ alias, emoji, size, border, hat }: {
  alias: string;
  emoji: string;
  size: number;
  border?: string;
  hat?: boolean;
}) {
  const hue = santaAliasHue(alias);
  const circle = (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `hsl(${hue}, 55%, 82%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.55),
      ...(border ? { border } : {}),
    }}>
      {emoji || '🎅'}
    </div>
  );
  if (!hat) return circle;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {circle}
      <SantaHatOverlay size={size} />
    </div>
  );
}
