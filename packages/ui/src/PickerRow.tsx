import React, { forwardRef, type ButtonHTMLAttributes, type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, fontFamily } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Tappable list-row inside picker bottom-sheets
 * (transfer-picker, copy-picker, wishlist-picker, etc).
 *
 * Functionally a `<button>` (whole row clickable) but visually a list tile:
 * surface bg + border, internal flex layout with leading icon, title +
 * optional subtitle, and trailing slot (chevron / count / checkmark / ✓).
 *
 * Source: 5+ identical `<button style={{ ...btnGhost, background: C.surface,
 * border: ..., textAlign: 'start' }}>` patterns inside picker `<BottomSheet>`s
 * in `apps/web/app/miniapp/MiniApp.tsx`.
 *
 * Different from `<ListRow>` because:
 *   - Renders as `<button>` (full row tappable, keyboard-focusable, disabled-aware)
 *   - Tighter shape (radius 12, padding 14px 16px) tuned for sheet-content density
 *   - No state-tint matrix (always neutral surface)
 */
export interface PickerRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> {
  /** Leading slot — emoji, icon, avatar, or thumbnail. */
  leading?: ReactNode;
  /** Row title (bold, primary text). */
  title: ReactNode;
  /** Optional subtitle / metadata under the title. */
  subtitle?: ReactNode;
  /** Trailing slot — chevron, count badge, ✓, etc. Default chevron `›`. */
  trailing?: ReactNode;
  /** Hide the default trailing chevron when no `trailing` slot is provided. */
  hideChevron?: boolean;
  /** Selected state — accent border + soft accent bg (used in choice pickers). */
  selected?: boolean;
}

export const PickerRow = forwardRef<HTMLButtonElement, PickerRowProps>(function PickerRow(
  {
    leading,
    title,
    subtitle,
    trailing,
    hideChevron,
    selected,
    disabled,
    style,
    type = 'button',
    ...rest
  },
  ref,
) {
  const baseStyle: CSSProperties = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    borderRadius: radius.lg,
    background: selected
      ? `var(--wb-accent-soft, ${colors.accentSoft})`
      : `var(--wb-surface, ${colors.surface})`,
    border: `1px solid ${selected
      ? `var(--wb-accent, ${colors.accent})`
      : `var(--wb-border, ${colors.border})`}`,
    color: `var(--wb-text, ${colors.text})`,
    fontFamily: fontFamily.sans,
    textAlign: 'start',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'background 0.15s, border-color 0.15s',
    ...style,
  };

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      style={baseStyle}
      {...rest}
    >
      {leading != null && <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{leading}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: fontSize.lg,
          fontWeight: fontWeight.semibold,
          color: `var(--wb-text, ${colors.text})`,
          lineHeight: 1.3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: fontSize.sm,
            color: `var(--wb-text-muted, ${colors.textMuted})`,
            marginTop: 2,
            lineHeight: 1.35,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {subtitle}
          </div>
        )}
      </div>
      {trailing != null
        ? <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}>{trailing}</span>
        : !hideChevron && (
          <span style={{
            fontSize: 18,
            color: `var(--wb-text-muted, ${colors.textMuted})`,
            fontWeight: 300,
            flexShrink: 0,
          }}>
            ›
          </span>
        )}
    </button>
  );
});
