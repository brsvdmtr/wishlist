import React, { useEffect, useRef, type ReactNode, type CSSProperties } from 'react';
import { colors, radius, fontSize, fontWeight, fontFamily } from '@wishlist/ui-tokens';

/**
 * @status **canonical** (2026-04-20, absorbed iOS-touch behavior from
 * the in-monolith `BottomSheet` — sheetRef scroll + drag-to-dismiss +
 * velocity inertia + keyboard blur on scroll + text-field gesture bypass).
 *
 * Drop-in replacement for the legacy `BottomSheet` component in
 * `MiniApp.tsx`. Accepts `open` (preferred) OR `isOpen` (back-compat
 * alias) so a simple `import { Sheet as BottomSheet }` rename covers
 * all existing call-sites without prop churn.
 *
 * Approval: `DESIGN_DECISIONS.md#2026-04-20--sheet-primitive-absorbs-bottomsheet-ios-touch-behavior-promoted-to-canonical`.
 *
 * Why custom touch handling (not native `overflowY:auto`):
 *   iOS WKWebView (Telegram) claims the gesture once native scroll
 *   starts and stops honouring `preventDefault()` after that point.
 *   So we always `preventDefault` and drive `scrollTop` + `transform`
 *   directly — zero React re-renders in the hot path means buttery
 *   60fps on the GPU compositor thread.
 */

function blurActiveField(): void {
  if (typeof document === 'undefined') return;
  const el = document.activeElement;
  if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    el.blur();
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea');
}

export interface SheetProps {
  /** Preferred prop name. */
  open?: boolean;
  /** Legacy alias for `open` — keeps `<BottomSheet isOpen={...}>` call-sites working. */
  isOpen?: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Max height as CSS. Default `85vh`. */
  maxHeight?: string;
  /** Dismiss sheet when backdrop is tapped. Default `true`. */
  dismissOnBackdrop?: boolean;
  /** Show the drag handle. Default `true`. */
  handle?: boolean;
  contentStyle?: CSSProperties;
}

export function Sheet({
  open,
  isOpen,
  onClose,
  title,
  children,
  // `dvh` = dynamic viewport height. On iOS 15.4+/Safari 16+ the browser
  // automatically shrinks this when the keyboard opens — no JS needed.
  // Falls back to `vh` on older browsers (rare in Telegram mini-apps).
  maxHeight = '85dvh',
  dismissOnBackdrop = true,
  handle = true,
  contentStyle,
}: SheetProps) {
  const visible = open ?? isOpen ?? false;
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Keep onClose stable inside native listeners without re-subscribing
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Backdrop: block ALL touch scroll on the underlying screen via non-passive listener
  useEffect(() => {
    const el = backdropRef.current;
    if (!el || !visible) return;
    const block = (e: TouchEvent) => {
      // Allow native touch gestures when a text field is focused — iOS needs
      // unblocked touchmove for selection handle dragging to work.
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, [visible]);

  // NOTE: keyboard-aware sizing is handled natively via `maxHeight: '85dvh'`
  // (dynamic viewport height) in the style prop default. `dvh` shrinks
  // automatically when the iOS keyboard opens. No JS handler needed —
  // avoids the mid-animation "cut off" flashes we saw with visualViewport
  // listeners trying to sync manually.

  // Sheet: take FULL ownership of scrolling + swipe-to-dismiss.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !visible) return;
    let prevY: number | null = null;
    let dismissOffset = 0;
    let cumulativeMove = 0;
    let blurFired = false;
    let samples: Array<{ t: number; y: number }> = [];
    let momentumFrame: number | null = null;

    const cancelMomentum = () => {
      if (momentumFrame !== null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
      }
    };

    const setTranslate = (y: number) => {
      sheet.style.transform = y === 0 ? '' : `translateY(${y}px)`;
    };

    const onStart = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      cancelMomentum();
      prevY = e.touches[0].clientY;
      dismissOffset = 0;
      cumulativeMove = 0;
      blurFired = false;
      samples = [{ t: performance.now(), y: prevY }];
      sheet.style.transition = 'none';
    };

    const onMove = (e: TouchEvent) => {
      if (prevY === null || !e.touches[0]) return;

      const currentY = e.touches[0].clientY;
      const dy = currentY - prevY;
      const absDy = Math.abs(dy);

      // If a text field is focused, give iOS ~10px to classify the gesture
      // as text-selection. Once cumulative movement exceeds 10px, it's clearly
      // a scroll intent — blur the field, then fall through to normal scroll
      // handling (preventDefault + scrollTop + dismiss).
      const active = document.activeElement;
      const fieldFocused = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (fieldFocused && !blurFired) {
        cumulativeMove += absDy;
        if (cumulativeMove > 10) {
          blurActiveField();
          blurFired = true;
          // Do NOT return — continue into normal scroll handling with the
          // now-blurred field. Blur triggers keyboard dismiss + viewport
          // resize; visualViewport listener updates maxHeight accordingly.
        } else {
          // Still below threshold — let iOS handle text selection.
          return;
        }
      }

      e.preventDefault();

      prevY = currentY;

      const now = performance.now();
      samples.push({ t: now, y: currentY });
      while (samples.length > 0 && now - samples[0]!.t > 100) samples.shift();

      // Secondary blur check — when no field was focused at start but one got
      // focused mid-gesture (unusual but possible).
      if (!blurFired) {
        cumulativeMove += absDy;
        if (cumulativeMove > 20) {
          blurActiveField();
          blurFired = true;
        }
      }

      if (dy < 0) {
        // Finger up → scroll content down
        sheet.scrollTop = Math.min(
          sheet.scrollTop - dy,
          sheet.scrollHeight - sheet.clientHeight,
        );
        if (dismissOffset > 0) {
          dismissOffset = 0;
          setTranslate(0);
        }
      } else if (dy > 0) {
        if (sheet.scrollTop > 0) {
          const next = sheet.scrollTop - dy;
          if (next > 0) {
            sheet.scrollTop = next;
          } else {
            sheet.scrollTop = 0;
            dismissOffset = -next;
            setTranslate(dismissOffset);
          }
        } else {
          dismissOffset += dy;
          setTranslate(dismissOffset);
        }
      }
    };

    const onEnd = () => {
      prevY = null;
      if (dismissOffset > 80) {
        sheet.style.transition = 'transform 0.22s ease-in';
        setTranslate(sheet.offsetHeight + 40);
        setTimeout(() => onCloseRef.current(), 220);
        dismissOffset = 0;
        return;
      }
      if (dismissOffset > 0) {
        sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
        setTranslate(0);
        dismissOffset = 0;
        return;
      }
      dismissOffset = 0;

      // Momentum inertia (iOS-style)
      if (samples.length < 2) return;
      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const dt = last.t - first.t;
      if (dt <= 0) return;
      let velocity = (last.y - first.y) / dt;
      if (Math.abs(velocity) < 0.12) return;

      const decay = 0.95;
      let last_t = performance.now();
      const tick = () => {
        const nowT = performance.now();
        const frameDt = nowT - last_t;
        last_t = nowT;
        const delta = velocity * frameDt;
        const nextTop = sheet.scrollTop - delta;
        const maxTop = sheet.scrollHeight - sheet.clientHeight;
        if (nextTop <= 0) {
          sheet.scrollTop = 0;
          momentumFrame = null;
          return;
        }
        if (nextTop >= maxTop) {
          sheet.scrollTop = maxTop;
          momentumFrame = null;
          return;
        }
        sheet.scrollTop = nextTop;
        velocity *= Math.pow(decay, frameDt / 16);
        if (Math.abs(velocity) < 0.02) {
          momentumFrame = null;
          return;
        }
        momentumFrame = requestAnimationFrame(tick);
      };
      momentumFrame = requestAnimationFrame(tick);
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      cancelMomentum();
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <>
      <div
        ref={backdropRef}
        onClick={dismissOnBackdrop ? () => { blurActiveField(); onClose(); } : undefined}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 }}
      />
      <div
        ref={sheetRef}
        onClick={(e) => {
          // Tap on any non-editable area dismisses the keyboard — keeps UX
          // clean without disabling tap-to-focus on inputs.
          if (!isEditableTarget(e.target)) blurActiveField();
        }}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: colors.surface, borderRadius: '20px 20px 0 0',
          padding: 24, zIndex: 101, maxHeight, overflowY: 'auto',
          animation: 'slideUp 0.3s ease',
          willChange: 'transform',
          overscrollBehavior: 'contain' as never,
          WebkitOverflowScrolling: 'touch' as never,
          ...contentStyle,
        }}
      >
        {handle && (
          <div
            aria-hidden="true"
            style={{
              width: 40, height: 4, background: colors.textMuted,
              borderRadius: radius.full, margin: '0 auto 16px',
              opacity: 0.3, cursor: 'grab',
            }}
          />
        )}
        {title && (
          <div
            style={{
              fontSize: fontSize.xxl,
              fontWeight: fontWeight.bold,
              marginBottom: 16,
              fontFamily: fontFamily.sans,
              color: colors.text,
            }}
          >
            {title}
          </div>
        )}
        {children}
      </div>
    </>
  );
}
