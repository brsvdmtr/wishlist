'use client';

import React, { type ReactNode } from 'react';
import { Chip } from '@wishlist/ui';

/**
 * v2.1 Wishlist card for the Home screen.
 *
 * Source of truth: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`
 * (`.wb-wl-card` + `HomeScreen` > `WishlistCard`).
 *
 * Layout: glass card (r=22) with
 *   - 54×54 emoji thumb (rounded-square, accent-soft gradient)
 *   - title + subtitle
 *   - optional inline Chip (deadline / progress %)
 *   - 3px progress bar (accent → accentStrong gradient)
 *   - footer row: countdown text
 *
 * `highlight=true` adds the pressed/active pill treatment for the
 * first card in the list (accent-soft tint + ambient glow).
 *
 * Participant AvatarStack will be added in a follow-up wave once the
 * backend exposes per-wishlist contributor data. For now, we render a
 * simpler footer with countdown only.
 */

export interface WishlistCardV21Props {
  emoji: string;
  title: ReactNode;
  /** Subtitle — usually "N желаний · M забронировано". */
  subtitle: ReactNode;
  /** Progress 0-100. Hidden when `undefined`. */
  progress?: number;
  /** Inline chip near title (e.g. "14 дней", "75%"). */
  chip?: { tone: 'accent' | 'success' | 'warning'; label: string };
  /** Countdown / deadline text (right side of footer). */
  countdown?: ReactNode;
  /** First-in-list highlight treatment (accent tint + ambient glow). */
  highlight?: boolean;
  /** Read-only wishlist — dims the card and swaps accent thumb for neutral. */
  readOnly?: boolean;
  onClick?: () => void;
  /** Additional animation delay index for staggered fade-in. */
  index?: number;
}

export function WishlistCardV21({
  emoji,
  title,
  subtitle,
  progress,
  chip,
  countdown,
  highlight = false,
  readOnly = false,
  onClick,
  index = 0,
}: WishlistCardV21Props) {
  return (
    <div
      onClick={onClick}
      className="wb-card-pressed"
      style={{
        background: highlight
          ? 'linear-gradient(135deg, var(--wb-card-strong), var(--wb-accent-soft))'
          : 'var(--wb-card)',
        border: `1px solid ${highlight ? 'var(--wb-accent-soft-strong)' : 'var(--wb-border)'}`,
        borderRadius: 22,
        padding: 18,
        marginBottom: 10,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
        WebkitBackdropFilter: 'blur(16px)' as never,
        backdropFilter: 'blur(16px)' as never,
        position: 'relative',
        overflow: 'hidden',
        opacity: readOnly ? 0.85 : 1,
        animation: `fadeIn 0.3s ease ${(index + 1) * 0.08}s both`,
      }}
    >
      {/* Highlight ambient glow (only on first card) */}
      {highlight && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-40%',
            right: '-20%',
            width: 180,
            height: 180,
            background:
              'radial-gradient(circle, var(--wb-accent-soft-strong), transparent 65%)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Top row — emoji thumb + title/sub */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          marginBottom: 14,
          position: 'relative',
        }}
      >
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 18,
            background: readOnly
              ? 'var(--wb-surface)'
              : 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            flexShrink: 0,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          {emoji}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap' as const,
            }}
          >
            <div
              style={{
                fontSize: 17,
                fontWeight: 650,
                letterSpacing: '-0.02em',
                color: 'var(--wb-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
              }}
            >
              {title}
            </div>
            {chip && (
              <Chip tone={chip.tone} size="sm">
                {chip.label}
              </Chip>
            )}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--wb-text-secondary)',
              marginTop: 3,
              letterSpacing: '-0.005em',
            }}
          >
            {subtitle}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {typeof progress === 'number' && (
        <div
          style={{
            height: 3,
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${Math.max(0, Math.min(100, progress))}%`,
              background:
                'linear-gradient(90deg, var(--wb-accent), var(--wb-accent-strong))',
              borderRadius: 2,
              boxShadow: '0 0 12px var(--wb-accent-shadow-soft)',
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      )}

      {/* Footer — countdown */}
      {countdown && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            marginTop: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: 'var(--wb-text-muted)',
              fontFeatureSettings: '"tnum"',
            }}
          >
            {countdown}
          </div>
        </div>
      )}
    </div>
  );
}
