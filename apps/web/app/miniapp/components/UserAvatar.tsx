import React from 'react';
import { SantaHatOverlay } from './SantaHatOverlay';

/**
 * UserAvatar — circle avatar with either a remote photo or the first
 * uppercase initial of `name` over an accent-coloured gradient. Falls back
 * to "?" when no name. Pass `hat={true}` during Santa season to overlay
 * the festive hat.
 *
 * Extracted from MiniApp.tsx (Phase 5b — extraction pilot).
 */
export function UserAvatar({
  avatarUrl, name, size, accent, border, style: extraStyle, hat,
}: {
  avatarUrl?: string | null;
  name?: string | null;
  size: number;
  accent: string;
  border?: string;
  style?: React.CSSProperties;
  hat?: boolean;
}) {
  const initial = ((name ?? '?').trim() || '?')[0]!.toUpperCase();
  const avatarDiv = (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `linear-gradient(135deg, ${accent}, ${accent}80)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 700, color: '#fff',
      ...(border ? { border } : {}),
      ...(avatarUrl
        ? { backgroundImage: `url(${avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : {}),
      ...extraStyle,
    }}>{!avatarUrl && initial}</div>
  );
  if (!hat) return avatarDiv;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {avatarDiv}
      <SantaHatOverlay size={size} />
    </div>
  );
}
