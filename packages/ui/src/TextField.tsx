import React, { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { colors, fontSize, fontWeight, fontFamily, letterSpacing } from '@wishlist/ui-tokens';

/**
 * @status v2.1 — `provisional`. Glass-surface text input matching the v2.1
 * `.wb-input` spec (radius 16, accent-tinted glass, backdrop-filter blur).
 *
 * Replaces the local `inputStyle` constant duplicated across ~30 sheets in
 * `apps/web/app/miniapp/MiniApp.tsx`. Use the same component for `<input>`
 * and `<textarea>` — pass `multiline` (and optional `rows`) to switch.
 *
 * Source: `mockups/approved/v2.1-refresh-all-screens.html` (`.wb-input`).
 *
 * iOS WKWebView quirk: explicit `lineHeight: '22px'` is required — without it,
 * `fontWeight: 500 + letterSpacing: -0.012em` causes the WebKit caret to render
 * displaced vertically in focused inputs. Don't override `lineHeight`.
 */

type InputBaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>;
type TextareaBaseProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

interface TextFieldCommonProps {
  /** Optional label rendered above the field. */
  label?: ReactNode;
  /** Hint or error message rendered below the field. */
  hint?: ReactNode;
  /** Renders character counter `value.length / maxLength`. */
  counter?: boolean;
  /** Wrapper style for the label/field/hint stack. */
  wrapperStyle?: CSSProperties;
  /** Additional style for the field itself (rare — usually unneeded). */
  style?: CSSProperties;
}

export type TextFieldProps =
  | (TextFieldCommonProps & InputBaseProps & { multiline?: false })
  | (TextFieldCommonProps & TextareaBaseProps & { multiline: true });

const fieldBaseStyle: CSSProperties = {
  width: '100%',
  padding: '14px 16px',
  borderRadius: 16,
  border: `1px solid var(--wb-border, ${colors.border})`,
  background: `var(--wb-card, ${colors.card})`,
  color: `var(--wb-text, ${colors.text})`,
  fontSize: fontSize.lg,
  fontWeight: fontWeight.medium,
  lineHeight: '22px',
  letterSpacing: letterSpacing.tight,
  fontFamily: fontFamily.sans,
  outline: 'none',
  boxSizing: 'border-box',
  WebkitBackdropFilter: 'blur(14px)' as never,
  backdropFilter: 'blur(14px)' as never,
  WebkitUserSelect: 'text' as never,
  userSelect: 'text',
  touchAction: 'auto',
};

export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(
  function TextField(props, ref) {
    const { label, hint, counter, wrapperStyle, style, ...rest } = props as TextFieldCommonProps & {
      multiline?: boolean;
      maxLength?: number;
      value?: string;
    };

    const value = (rest as { value?: string }).value ?? '';
    const maxLength = (rest as { maxLength?: number }).maxLength;

    const fieldStyle: CSSProperties = { ...fieldBaseStyle, ...style };

    const field = props.multiline ? (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        style={fieldStyle}
        {...(rest as TextareaBaseProps)}
      />
    ) : (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        style={fieldStyle}
        {...(rest as InputBaseProps)}
      />
    );

    if (!label && !hint && !counter) {
      return field;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...wrapperStyle }}>
        {label && (
          <label style={{
            display: 'block', fontSize: fontSize.sm,
            color: `var(--wb-text-secondary, ${colors.textSecondary})`,
            fontWeight: fontWeight.medium,
          }}>
            {label}
          </label>
        )}
        {field}
        {(hint || counter) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            {hint && (
              <span style={{
                fontSize: fontSize.xs,
                color: `var(--wb-text-muted, ${colors.textMuted})`,
                lineHeight: 1.4,
              }}>
                {hint}
              </span>
            )}
            {counter && maxLength != null && (
              <span style={{
                fontSize: fontSize.xs,
                color: `var(--wb-text-muted, ${colors.textMuted})`,
                whiteSpace: 'nowrap',
                marginLeft: 'auto',
              }}>
                {value.length}/{maxLength}
              </span>
            )}
          </div>
        )}
      </div>
    );
  },
);
