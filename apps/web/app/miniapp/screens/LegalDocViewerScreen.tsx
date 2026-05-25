// Legal doc viewer — extracted from MiniApp.tsx (F4 Wave A).
// Renders a single LEGAL_DOCS entry. Body uses a tiny in-file Markdown-ish
// renderer: section headings (N. …), sub-headings (N.N. …), bullets (•), and
// t.me URLs become tappable.

'use client';

import type { ReactNode } from 'react';
import { t, type Locale } from '@wishlist/shared';
import { LEGAL_DOCS } from './data/legal-docs';

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

export interface LegalDocViewerScreenProps {
  locale: Locale;
  /** Null = renders nothing (the screen-switch should suppress this case but we guard anyway). */
  docId: string | null;
}

export function LegalDocViewerScreen({ locale, docId }: LegalDocViewerScreenProps) {
  if (!docId) return null;
  const doc = LEGAL_DOCS.find((d) => d.id === docId);
  if (!doc) return null;

  const body = (doc.body[locale] ?? doc.body.en) || '';
  const isRtl = locale === 'ar';
  // Legal copy in RU is authoritative; for other locales we show a fallback
  // disclaimer that the translation may lag.
  const showDisclaimer = locale !== 'ru';

  return (
    <div style={{
      padding: '16px 20px 120px',
      animation: 'fadeIn 0.3s ease',
      direction: isRtl ? 'rtl' : 'ltr',
    }}>
      <h1 style={{
        fontSize: 20, fontWeight: 800, fontFamily: font,
        color: 'var(--wb-text)', margin: '0 0 6px',
      }}>
        {doc.title[locale] ?? doc.title.en}
      </h1>
      <div style={{
        display: 'flex', gap: 12,
        fontSize: 12, color: 'var(--wb-text-muted)', marginBottom: 20,
      }}>
        <span>{t('legal_version', locale, { v: doc.version })}</span>
        <span>·</span>
        <span>{t('legal_effective', locale, { date: doc.effectiveDate })}</span>
      </div>

      <div style={{
        background: 'var(--wb-card)', borderRadius: 16, padding: '16px 16px 8px',
      }}>
        {renderBody(body)}
      </div>

      {showDisclaimer && (
        <div style={{
          marginTop: 16, padding: '12px 14px',
          background: 'var(--wb-surface)', borderRadius: 12,
          fontSize: 12, color: 'var(--wb-text-muted)', lineHeight: 1.5,
          textAlign: isRtl ? 'right' : 'left',
        }}>
          {t('legal_locale_disclaimer', locale)}
        </div>
      )}
    </div>
  );
}

/**
 * Simple block renderer: splits body by `\n\n` into blocks.
 *  - "N. Title" → section heading (bold).
 *  - "N.N. Title" → sub-heading.
 *  - "• …" → bullet.
 *  - lines with https://t.me/… → tappable links via Telegram WebApp API.
 *  - everything else → normal paragraph.
 */
function renderBody(text: string): ReactNode {
  const blocks = text.split('\n\n');
  return blocks.map((block, bi) => {
    const lines = block.split('\n');
    return (
      <div key={bi} style={{ marginBottom: 14 }}>
        {lines.map((line, li) => {
          if (/^\d+\.\s/.test(line) && !/^\d+\.\d+/.test(line)) {
            return (
              <div key={li} style={{
                fontSize: 15, fontWeight: 700, color: 'var(--wb-text)',
                marginTop: bi > 0 ? 4 : 0, lineHeight: 1.4,
              }}>
                {line}
              </div>
            );
          }
          if (/^\d+\.\d+\.?\s/.test(line)) {
            return (
              <div key={li} style={{
                fontSize: 14, color: 'var(--wb-text-secondary)', lineHeight: 1.55,
              }}>
                {line}
              </div>
            );
          }
          if (line.startsWith('• ')) {
            return (
              <div key={li} style={{ display: 'flex', gap: 8, paddingLeft: 4 }}>
                <span style={{
                  color: 'var(--wb-text-muted)', flexShrink: 0, lineHeight: 1.55,
                }}>•</span>
                <span style={{
                  fontSize: 14, color: 'var(--wb-text-secondary)', lineHeight: 1.55,
                }}>{line.slice(2)}</span>
              </div>
            );
          }
          if (/https:\/\/t\.me\//.test(line)) {
            const parts = line.split(/(https:\/\/t\.me\/\S+)/);
            return (
              <div key={li} style={{
                fontSize: 14, color: 'var(--wb-text-secondary)', lineHeight: 1.55,
              }}>
                {parts.map((part, pi) =>
                  /^https:\/\/t\.me\//.test(part) ? (
                    <span
                      key={pi}
                      onClick={() => {
                        try { window.Telegram?.WebApp?.openTelegramLink?.(part); }
                        catch { window.open(part, '_blank'); }
                      }}
                      style={{
                        color: 'var(--wb-accent)',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                      }}
                    >{part}</span>
                  ) : <span key={pi}>{part}</span>
                )}
              </div>
            );
          }
          return (
            <div key={li} style={{
              fontSize: 14, color: 'var(--wb-text-secondary)', lineHeight: 1.55,
            }}>
              {line}
            </div>
          );
        })}
      </div>
    );
  });
}
