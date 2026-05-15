import React from 'react';

// Hardcoded positions/timings (no Math.random) so re-renders don't reshuffle
// the animation. `pointer-events:none` everywhere — purely decorative.
const SNOW_FLAKES = [
  { left: '6%',  delay: '0s',    dur: '4.4s', op: 0.55, size: 11 },
  { left: '19%', delay: '1.5s',  dur: '3.7s', op: 0.40, size: 9  },
  { left: '34%', delay: '0.8s',  dur: '5.1s', op: 0.50, size: 12 },
  { left: '50%', delay: '2.2s',  dur: '4.0s', op: 0.35, size: 10 },
  { left: '65%', delay: '0.4s',  dur: '4.8s', op: 0.60, size: 11 },
  { left: '79%', delay: '1.9s',  dur: '3.9s', op: 0.45, size: 9  },
  { left: '92%', delay: '1.2s',  dur: '5.3s', op: 0.38, size: 10 },
] as const;

/**
 * Seasonal snowfall band — 7 hardcoded snowflakes drift down from the top.
 * Animation timing is deterministic across re-renders (no Math.random).
 *
 * Extracted from MiniApp.tsx (Phase 5b — extraction pilot).
 */
export function SnowflakeOverlay({ height = 72 }: { height?: number }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: 0, height,
      overflow: 'hidden', pointerEvents: 'none', userSelect: 'none', zIndex: 0,
    }}>
      {SNOW_FLAKES.map((f, i) => (
        <span key={i} className="snowflake" style={{
          position: 'absolute',
          left: f.left, top: -12,
          fontSize: f.size,
          opacity: f.op,
          color: 'rgba(180,220,245,.9)',
          lineHeight: 1,
          animation: `snowfall ${f.dur} ease-in ${f.delay} infinite`,
        }}>❄</span>
      ))}
    </div>
  );
}
