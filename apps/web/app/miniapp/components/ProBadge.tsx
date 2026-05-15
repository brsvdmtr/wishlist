import React from 'react';

/**
 * `PRO` tier badge — small inline pill rendered next to user names, plan
 * labels, and feature gates throughout the Mini App. Uses accent CSS vars
 * so it adapts to the active theme × accent.
 *
 * Extracted from MiniApp.tsx (Phase 5b — extraction pilot) so the RTL
 * pattern is established for future component extractions. Original
 * declaration removed from MiniApp.tsx in the same commit.
 */
export function ProBadge({ style }: { style?: React.CSSProperties } = {}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      height: 20, minHeight: 20, padding: '0 8px',
      borderRadius: 5,
      background: 'linear-gradient(135deg, var(--wb-accent, #7C6AFF), var(--wb-accent-strong, #A78BFA))',
      color: '#fff',
      fontSize: 10, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1,
      whiteSpace: 'nowrap', flexShrink: 0,
      verticalAlign: 'middle',
      boxSizing: 'border-box',
      ...style,
    }}>PRO</span>
  );
}
