// FAQ screen — extracted from MiniApp.tsx (F4 Wave A).
// Cold path (Settings → FAQ). Self-contained: only needs `locale`.
// Uses CSS variables from v2.1 (var(--wb-*)) so no theme prop needed.
// Local accordion state — no parent coupling.

'use client';

import { useState } from 'react';
import { t, type Locale } from '@wishlist/shared';
import { Button } from '@wishlist/ui';

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

const FAQ_SECTIONS: { titleKey: string; icon: string; items: number[] }[] = [
  { titleKey: 'faq_sec_about', icon: '📱', items: [1] },
  { titleKey: 'faq_sec_plans', icon: '⭐', items: [2, 15, 16, 17, 18, 19, 14] },
  { titleKey: 'faq_sec_payments', icon: '💎', items: [20, 21, 22, 12, 23] },
  { titleKey: 'faq_sec_reservations', icon: '🎁', items: [3, 4, 5, 24, 25] },
  { titleKey: 'faq_sec_secret_res', icon: '🤫', items: [26, 27, 28] },
  { titleKey: 'faq_sec_smart_res', icon: '⏱', items: [29, 30, 31] },
  { titleKey: 'faq_sec_group_gift', icon: '👥', items: [32, 33, 34, 35] },
  { titleKey: 'faq_sec_notes_dontgift', icon: '📝', items: [7, 36, 37] },
  { titleKey: 'faq_sec_showcase', icon: '✨', items: [38, 39, 40] },
  { titleKey: 'faq_sec_links', icon: '🔗', items: [9, 10, 41, 42] },
  { titleKey: 'faq_sec_comments', icon: '💬', items: [6, 8, 43] },
  { titleKey: 'faq_sec_santa', icon: '🎅', items: [44, 45] },
  { titleKey: 'faq_sec_archive', icon: '🗄', items: [11, 46, 47] },
  { titleKey: 'faq_sec_support', icon: '🛟', items: [13, 48] },
  { titleKey: 'faq_sec_upcoming', icon: '🚧', items: [49, 50] },
];

const SUPPORT_URL = 'https://t.me/Wish_Support';

export interface FAQScreenProps {
  locale: Locale;
}

export function FAQScreen({ locale }: FAQScreenProps) {
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
      <h1 style={{
        fontSize: 26, fontWeight: 700, fontFamily: font,
        color: 'var(--wb-text)', letterSpacing: '-0.035em',
        lineHeight: 1.05, margin: '0 0 4px',
      }}>
        {t('faq_title', locale)}
      </h1>
      <p style={{
        fontSize: 13, color: 'var(--wb-text-muted)',
        margin: '0 0 20px', lineHeight: 1.4,
      }}>
        {t('faq_subtitle', locale)}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {FAQ_SECTIONS.map((sec) => (
          <div key={sec.titleKey} style={{
            background: 'var(--wb-card)', borderRadius: 16, overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 8,
              borderBottom: '1px solid var(--wb-border)',
            }}>
              <span style={{ fontSize: 16 }}>{sec.icon}</span>
              <span style={{
                fontSize: 13, fontWeight: 700,
                color: 'var(--wb-text)', letterSpacing: '-0.01em',
              }}>
                {t(sec.titleKey as never, locale)}
              </span>
            </div>
            {sec.items.map((qNum, idx) => {
              const isOpen = openId === qNum;
              return (
                <div key={qNum}>
                  {idx > 0 && (
                    <div style={{
                      borderTop: '1px solid var(--wb-border)',
                      margin: '0 16px',
                    }} />
                  )}
                  <div
                    onClick={() => setOpenId(isOpen ? null : qNum)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12,
                      padding: '14px 16px', cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 14, fontWeight: 600,
                        color: 'var(--wb-text)', lineHeight: 1.4,
                      }}>
                        {t(`faq_q${qNum}` as never, locale)}
                      </div>
                      {isOpen && (
                        <div style={{
                          fontSize: 13, color: 'var(--wb-text-secondary)',
                          lineHeight: 1.55, marginTop: 8,
                          whiteSpace: 'pre-line',
                          animation: 'fadeIn 0.2s ease',
                        }}>
                          {t(`faq_a${qNum}` as never, locale)}
                        </div>
                      )}
                    </div>
                    <span style={{
                      fontSize: 18, color: 'var(--wb-text-muted)',
                      lineHeight: 1, flexShrink: 0,
                      transform: isOpen ? 'rotate(90deg)' : 'none',
                      transition: 'transform 0.2s ease',
                      marginTop: 1,
                    }}>›</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 20, background: 'var(--wb-surface)', borderRadius: 16,
        padding: '20px 16px', textAlign: 'center',
      }}>
        <div style={{
          fontSize: 14, fontWeight: 600,
          color: 'var(--wb-text)', marginBottom: 4,
        }}>
          {t('faq_support_cta', locale)}
        </div>
        <Button
          variant="primary"
          size="sm"
          fullWidth={false}
          style={{ marginTop: 10, padding: '12px 24px', fontSize: 14, minHeight: 0 }}
          onClick={() => {
            try {
              window.Telegram?.WebApp?.openTelegramLink?.(SUPPORT_URL);
            } catch {
              window.open(SUPPORT_URL, '_blank');
            }
          }}
        >
          {t('faq_support_btn', locale)}
        </Button>
      </div>
    </div>
  );
}
