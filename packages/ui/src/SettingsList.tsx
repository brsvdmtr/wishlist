import React, { type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, fontFamily, transition } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Settings-screen primitives extracted from
 * `MiniApp.tsx` (`SettingsSection` / `SettingsRow` / `SettingsToggle` /
 * `SettingsActionRow` closures previously defined inside the Settings screen).
 *
 * These are tighter-than-`<ListRow>` — Settings rows live INSIDE a glass card
 * (`SettingsSection`), share an outer border, and use 14px padding-Y with no
 * per-row border. Different shape from the canonical `<ListRow>` which is a
 * standalone tile.
 *
 * Source: `mockups/approved/v2.1-refresh-all-screens.html` (Settings group).
 *
 * Use these in any settings-style screen: appearance, notifications,
 * subscription management, etc.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SettingsSection — group container with uppercase micro-label + glass body
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsSectionProps {
  /** Group title (uppercase micro-label rendered above the card). */
  title: ReactNode;
  /** Children — typically `SettingsRow` / `SettingsToggle` / `SettingsActionRow`. */
  children: ReactNode;
  /** First section in the screen — reduces top margin. Default `false`. */
  first?: boolean;
  /** Optional santa-season tint overlay. */
  santaTint?: boolean;
  /** Wrapper style override. */
  style?: CSSProperties;
}

export function SettingsSection({ title, children, first, santaTint, style }: SettingsSectionProps) {
  return (
    <div style={style}>
      <div style={{
        fontSize: fontSize.xs,
        fontWeight: fontWeight.semibold,
        color: `var(--wb-text-muted, ${colors.textMuted})`,
        marginBottom: 10,
        marginTop: first ? 4 : 22,
        textTransform: 'uppercase',
        letterSpacing: '0.7px',
        paddingLeft: 4,
      }}>
        {title}
      </div>
      <div style={{
        background: santaTint
          ? `linear-gradient(to bottom, rgba(160,210,240,.09) 0%, transparent 10px), var(--wb-card, ${colors.card})`
          : `var(--wb-card, ${colors.card})`,
        border: `1px solid var(--wb-border, ${colors.border})`,
        borderRadius: 20,
        padding: '4px 18px',
        WebkitBackdropFilter: 'blur(16px)' as never,
        backdropFilter: 'blur(16px)' as never,
        ...(santaTint ? { borderTop: '1px solid rgba(180,220,245,.18)' } : {}),
      }}>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsDivider — hairline between rows in a section
// ─────────────────────────────────────────────────────────────────────────────

export function SettingsDivider() {
  return <div style={{ height: 1, background: 'rgba(255,255,255,0.04)', marginLeft: 40 }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsRow — emoji-thumb leading + label + hint + value/chevron trailing
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsRowProps {
  /** Leading emoji or icon, rendered inside an accent-soft thumbnail. */
  icon?: ReactNode;
  label: ReactNode;
  /** Right-side value text. */
  value?: ReactNode;
  /** Subtitle / hint under the label. */
  hint?: ReactNode;
  /** When set, makes the row clickable; renders chevron. */
  onClick?: () => void;
  /** Show PRO badge after the label. Pass the badge as a node. */
  proBadge?: ReactNode;
  /** Show NEW badge after the label. Pass the badge as a node. */
  newBadge?: ReactNode;
  /** Greys out the row + replaces value with "coming soon" text. */
  disabled?: boolean;
  /** Renders the value text smaller (12px) for long values. */
  valueSmall?: boolean;
  /** Coming-soon label override (default "Скоро"). */
  comingSoonLabel?: ReactNode;
}

export function SettingsRow({
  icon, label, value, hint, onClick, proBadge, newBadge, disabled, valueSmall, comingSoonLabel = 'Скоро',
}: SettingsRowProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 0',
        gap: 14,
        cursor: onClick && !disabled ? 'pointer' : 'default',
        transition: transition.opacity,
      }}
    >
      {icon && (
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: disabled
            ? `var(--wb-surface, ${colors.surface})`
            : `linear-gradient(135deg, var(--wb-accent-soft-strong, ${colors.accentSoftStrong}), var(--wb-accent-soft, ${colors.accentSoft}))`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          flexShrink: 0,
          opacity: disabled ? 0.4 : 1,
          boxShadow: disabled ? undefined : 'inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          {icon}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, opacity: disabled ? 0.4 : 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: fontSize.lg,
            fontWeight: fontWeight.semibold,
            color: `var(--wb-text, ${colors.text})`,
            lineHeight: 1.3,
            letterSpacing: '-0.012em',
          }}>
            {label}
          </span>
          {proBadge}
          {newBadge}
        </div>
        {hint && (
          <div style={{
            fontSize: 12.5,
            color: `var(--wb-text-secondary, ${colors.textSecondary})`,
            marginTop: 2,
            letterSpacing: '-0.003em',
          }}>
            {hint}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, maxWidth: '45%' }}>
        {disabled ? (
          <span style={{ fontSize: fontSize.xs, color: `var(--wb-text-muted, ${colors.textMuted})`, fontWeight: fontWeight.medium }}>
            {comingSoonLabel}
          </span>
        ) : (
          <>
            {value && (
              <span style={{
                fontSize: valueSmall ? fontSize.xs : fontSize.base,
                color: `var(--wb-text-secondary, ${colors.textSecondary})`,
                textAlign: 'right',
                lineHeight: 1.3,
                letterSpacing: '-0.005em',
              }}>
                {value}
              </span>
            )}
            {onClick && (
              <span style={{
                fontSize: 18,
                color: `var(--wb-text-muted, ${colors.textMuted})`,
                fontWeight: 300,
              }}>
                {'›'}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsToggle — emoji-thumb + label + iOS-style switch (accent glow when on)
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsToggleProps {
  icon?: ReactNode;
  label: ReactNode;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  proBadge?: ReactNode;
}

export function SettingsToggle({ icon, label, value, onChange, disabled, proBadge }: SettingsToggleProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '14px 0', gap: 14 }}>
      {icon && (
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: `linear-gradient(135deg, var(--wb-accent-soft-strong, ${colors.accentSoftStrong}), var(--wb-accent-soft, ${colors.accentSoft}))`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          flexShrink: 0,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          {icon}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: fontSize.lg,
          fontWeight: fontWeight.semibold,
          color: disabled ? `var(--wb-text-muted, ${colors.textMuted})` : `var(--wb-text, ${colors.text})`,
          lineHeight: 1.3,
          letterSpacing: '-0.012em',
        }}>
          {label}
        </span>
        {proBadge}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        disabled={disabled && !proBadge}
        aria-pressed={value}
        style={{
          width: 46, height: 28, borderRadius: 100,
          border: value ? 'none' : `1px solid var(--wb-border, ${colors.border})`,
          cursor: disabled ? 'default' : 'pointer',
          background: value
            ? `linear-gradient(135deg, var(--wb-accent, ${colors.accent}), var(--wb-accent-deep, ${colors.accentDeep}))`
            : 'rgba(255,255,255,0.08)',
          position: 'relative',
          transition: 'all 0.2s ease',
          flexShrink: 0,
          boxShadow: value && !disabled
            ? `0 0 16px var(--wb-accent-shadow-soft, ${colors.accentGlow})`
            : 'none',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <div style={{
          width: 22, height: 22, borderRadius: '50%',
          background: '#fff',
          position: 'absolute',
          top: 2,
          left: value ? 22 : 2,
          transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.05)',
        }} />
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SettingsActionRow — leading thumb + label + chevron, full row clickable
//
// 2026-04-26: thumb shape unified with `<SettingsRow>` — 36×36 rounded square
// with a tone-aware gradient + inset highlight, replacing the previous
// 28×28 round circle + flat tint. Source: approved mockup
// `mockups/approved/settings-action-row-icons.html`.
// ─────────────────────────────────────────────────────────────────────────────

export type SettingsActionRowTone = 'accent' | 'success' | 'warning' | 'danger';

export interface SettingsActionRowProps {
  icon?: ReactNode;
  label: ReactNode;
  /** Override label color; passing `var(--wb-danger, ...)` also auto-promotes
   *  the thumb tone to `danger`. Default uses text + accent thumb. */
  color?: string;
  /** Explicit thumb tone. Falls back to a `color`-based heuristic for
   *  backwards-compat with call-sites that only pass `color`. */
  tone?: SettingsActionRowTone;
  onClick: () => void;
  /** Renders an accent dot before the chevron. */
  dot?: boolean;
}

const actionRowToneGradient: Record<SettingsActionRowTone, string> = {
  accent:  `linear-gradient(135deg, var(--wb-accent-soft-strong, ${colors.accentSoftStrong}), var(--wb-accent-soft, ${colors.accentSoft}))`,
  success: `linear-gradient(135deg, rgba(74,222,128,0.30), var(--wb-success-soft, ${colors.successSoft}))`,
  warning: `linear-gradient(135deg, rgba(251,191,36,0.30), var(--wb-warning-soft, ${colors.warningSoft}))`,
  danger:  `linear-gradient(135deg, rgba(251,113,133,0.30), var(--wb-danger-soft, ${colors.dangerSoft}))`,
};

export function SettingsActionRow({ icon, label, color, tone, onClick, dot }: SettingsActionRowProps) {
  // Detect danger via the legacy `color` prop (substring match against the
  // CSS-var name) so existing call-sites that only pass `color={C.red}`
  // automatically promote the thumb tone too.
  const resolvedTone: SettingsActionRowTone = tone
    ?? (typeof color === 'string' && color.includes('--wb-danger') ? 'danger' : 'accent');
  const labelColor = color || `var(--wb-text, ${colors.text})`;
  const chevronColor = color || `var(--wb-text-muted, ${colors.textMuted})`;
  return (
    <div
      onClick={onClick}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.45'; }}
      onPointerUp={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
      onPointerLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 0',
        gap: 14,
        cursor: 'pointer',
        transition: 'opacity 0.12s',
      }}
    >
      {icon && (
        <div style={{
          width: 36, height: 36, borderRadius: 12,
          background: actionRowToneGradient[resolvedTone],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 16,
          flexShrink: 0,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        }}>
          {icon}
        </div>
      )}
      <span style={{
        fontSize: fontSize.lg,
        fontWeight: fontWeight.semibold,
        color: labelColor,
        flex: 1,
        letterSpacing: '-0.012em',
        lineHeight: 1.3,
      }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {dot && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: `var(--wb-accent, ${colors.accent})`,
            flexShrink: 0,
          }} />
        )}
        <span style={{
          fontSize: 18,
          color: chevronColor,
          fontWeight: 300,
        }}>
          {'›'}
        </span>
      </div>
    </div>
  );
}
