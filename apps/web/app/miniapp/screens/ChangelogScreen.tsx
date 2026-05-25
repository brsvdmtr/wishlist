// Changelog screen — extracted from MiniApp.tsx (F4 Wave A).
// Cold path (Settings → Changelog). Self-contained: only `locale`.
// Local accordion state. Data lives in ./data/release-notes (lazy with this chunk).
// "Mark as seen" / badge logic is owned by the parent navigation handler in
// MiniApp.tsx (the parent already calls setChangelogSeenId when transitioning
// to this screen) — keeping that out of here preserves the original side-effect
// timing exactly.

'use client';

import { useState } from 'react';
import { t, pluralize, type Locale } from '@wishlist/shared';
import { RELEASE_NOTES } from './data/release-notes';

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

export interface ChangelogScreenProps {
  locale: Locale;
}

export function ChangelogScreen({ locale }: ChangelogScreenProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
      <h1 style={{
        fontSize: 26, fontWeight: 700, fontFamily: font,
        color: 'var(--wb-text)', letterSpacing: '-0.035em',
        lineHeight: 1.05, margin: '0 0 4px',
      }}>
        {t('changelog_title', locale)}
      </h1>
      <p style={{
        fontSize: 13, color: 'var(--wb-text-muted)',
        margin: '0 0 20px', lineHeight: 1.4,
      }}>
        {t('changelog_subtitle', locale)}
      </p>

      {RELEASE_NOTES.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
          <div style={{
            fontSize: 16, fontWeight: 700,
            color: 'var(--wb-text)', marginBottom: 8,
          }}>{t('changelog_empty_title', locale)}</div>
          <div style={{
            fontSize: 14, color: 'var(--wb-text-muted)', lineHeight: 1.5,
          }}>{t('changelog_empty_hint', locale)}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {RELEASE_NOTES.map((release) => {
            const isOpen = openId === release.id;
            return (
              <div key={release.id} style={{
                background: 'var(--wb-card)', borderRadius: 14, overflow: 'hidden',
              }}>
                <div
                  onClick={() => setOpenId(isOpen ? null : release.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 16px', cursor: 'pointer',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 15, fontWeight: 700,
                      color: 'var(--wb-text)', fontFamily: font,
                    }}>
                      {release.date}
                    </div>
                    {!isOpen && (
                      <div style={{
                        fontSize: 12, color: 'var(--wb-text-muted)', marginTop: 2,
                      }}>
                        {release.items.length} {pluralize(
                          release.items.length,
                          t('changes_one', locale),
                          t('changes_few', locale),
                          t('changes_many', locale),
                          locale,
                        )}
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: 18, color: 'var(--wb-text-muted)',
                    lineHeight: 1, flexShrink: 0,
                    transform: isOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.2s ease',
                  }}>›</span>
                </div>
                {isOpen && (
                  <div style={{
                    padding: '0 16px 14px', animation: 'fadeIn 0.2s ease',
                  }}>
                    <div style={{
                      borderTop: '1px solid var(--wb-border)',
                      paddingTop: 12,
                      display: 'flex', flexDirection: 'column', gap: 8,
                    }}>
                      {release.items.map((item, i) => (
                        <div key={i} style={{
                          display: 'flex', gap: 10, alignItems: 'flex-start',
                        }}>
                          <span style={{
                            color: 'var(--wb-accent)',
                            fontSize: 8, marginTop: 6, flexShrink: 0,
                          }}>●</span>
                          <span style={{
                            fontSize: 14, color: 'var(--wb-text-secondary)',
                            lineHeight: 1.45,
                          }}>
                            {item[locale] ?? item.en}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
