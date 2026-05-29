'use client';

// E13 — passive guest-view "create your own wishlist" banner (presentational).
//
// Composes the canonical <Banner tone="info"> primitive — NOT a new primitive.
// Soft accent-glass surface (deliberately not the louder `promo` gradient),
// inline in the list flow (never fixed / overlay), so it structurally cannot
// cover the reserve CTA (which lives on the separate guest-item-detail screen).
//
// Whether to render at all is decided by `shouldShowGuestBanner` in the parent
// (GuestViewRoot); this component owns only the one-shot `shown` signal, fired
// when it actually scrolls into view (IntersectionObserver) so the funnel
// denominator reflects real reach rather than mere DOM presence.
//
// Spec / mockup: see lib/guestBannerCta.ts header.

import { useEffect, useRef } from 'react';
import { Banner, Button } from '@wishlist/ui';
import { spacing } from '@wishlist/ui-tokens';
import { t, type Locale } from '@wishlist/shared';

export interface GuestViewBannerProps {
  locale: Locale;
  /** Fired exactly once, when the banner first enters the viewport. */
  onShown: () => void;
  /** Primary CTA tap — "Create my wishlist". */
  onCreate: () => void;
  /** × dismiss tap. */
  onDismiss: () => void;
}

export function GuestViewBanner({ locale, onShown, onCreate, onDismiss }: GuestViewBannerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const firedRef = useRef(false);
  // Keep the latest onShown without re-arming the observer (its effect runs
  // once on mount; a changing callback identity must not re-fire it).
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  useEffect(() => {
    const el = ref.current;
    if (!el || firedRef.current) return;

    const fire = () => {
      if (firedRef.current) return;
      firedRef.current = true;
      onShownRef.current();
    };

    // Old WebViews without IntersectionObserver: count as shown on mount
    // rather than dropping the impression entirely.
    if (typeof IntersectionObserver === 'undefined') {
      fire();
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            fire();
            io.disconnect();
            break;
          }
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ marginTop: spacing[3.5] }}>
      <Banner
        tone="info"
        icon={<span aria-hidden="true">✨</span>}
        title={t('e13_banner_title', locale)}
        onClose={onDismiss}
      >
        <div style={{ marginBottom: spacing[3] }}>{t('e13_banner_desc', locale)}</div>
        <Button variant="primary" size="md" onClick={onCreate}>
          {t('e13_banner_cta', locale)}
        </Button>
      </Banner>
    </div>
  );
}
